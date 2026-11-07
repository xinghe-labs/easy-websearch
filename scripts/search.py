#!/usr/bin/env python3
"""easy-web-search — multi-engine web search with RRF fusion and graceful degradation.

Zero dependencies (stdlib only). Python >= 3.11 (datetime.UTC). Honors
HTTP(S)_PROXY env vars automatically via urllib.

Usage:
  python3 search.py "query" [-n 10] [--days 7] [--site example.com]
       [--exclude-site foo.com] [--lang zh] [--engine ddg,bing]
       [--timeout 8] [--json]

Engines (baseline, no key): ddg, bing
Engines (enabled when env key present): brave (BRAVE_API_KEY),
  tavily (TAVILY_API_KEY), serper (SERPER_API_KEY), exa (EXA_API_KEY)
Backup engines (keyless, low anonymous quota — off by default; opt in via
  --engine or EASY_WEB_SEARCH_ENGINES=anysearch,keenable):
  anysearch (ANYSEARCH_API_KEY optional), keenable (KEENABLE_API_KEY optional)

Reliability-first: each engine runs independently with its own timeout;
failures never abort the run. Output reports per-engine status.
"""
import argparse
import base64
import concurrent.futures
import datetime
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
from urllib.request import build_opener

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
RRF_K = 60


def parse_json(body):
    """json.loads with a per-engine-safe error (callers isolate engines)."""
    try:
        return json.loads(body)
    except ValueError as e:
        raise RuntimeError(f"invalid JSON response: {e}") from e


def http_text(url: str, method: str = "GET", headers: dict | None = None,
              data: bytes | None = None, timeout: float = 8) -> tuple[int, str]:
    """Fetch an http(s) URL, return (status, body). Honors proxy env vars."""
    # Explicit scheme allowlist: only plain http(s) URLs may reach the opener.
    if not url.lower().startswith(("http://", "https://")):
        raise RuntimeError(f"disallowed URL scheme (want http/https): {url[:80]}")
    method = method.upper()
    if method not in ("GET", "POST"):
        raise RuntimeError(f"unsupported method: {method}")
    # Only the validated http(s) URL reaches the opener below.
    safe_url: str = urllib.parse.urlunsplit(urllib.parse.urlsplit(url))
    merged = {
        "User-agent": UA,
        "Accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        **(headers or {}),
    }
    opener = build_opener()
    opener.addheaders = list(merged.items())
    try:
        with opener.open(safe_url, data=data if method == "POST" else None,
                         timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")


def strip_tags(s):
    s = re.sub(r"<[^>]*>", "", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def normalize_url(u):
    try:
        x = urllib.parse.urlsplit(u)
        query = [(k, v) for k, v in urllib.parse.parse_qsl(x.query)
                 if not re.match(r"^(utm_|ref$|fbclid)", k, re.I)]
        s = urllib.parse.urlunsplit((x.scheme, x.netloc.lower(), x.path,
                                     urllib.parse.urlencode(query), ""))
        return s.rstrip("/")
    except ValueError:
        return u


def build_query(args):
    q = " ".join(args.query) if isinstance(args.query, list) else args.query
    for s in args.site:
        q += f" site:{s}"
    for s in args.exclude_site:
        q += f" -site:{s}"
    return q.strip()


# --------------------------------------------------------------- engines ----
def engine_ddg(ctx):
    params = {"q": ctx["query"], "nost": "1"}
    if ctx["lang"] == "zh":
        params["kl"] = "cn-zh"
    elif ctx["lang"] == "en":
        params["kl"] = "us-en"
    if ctx["days"] > 0:
        params["df"] = "d" if ctx["days"] <= 1 else ("w" if ctx["days"] <= 7 else "m")
    data = urllib.parse.urlencode(params).encode()
    status, body = http_text("https://html.duckduckgo.com/html/", method="POST",
                             data=data, headers={"content-type": "application/x-www-form-urlencoded"},
                             timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    results = []
    for m in re.finditer(r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', body):
        href = html.unescape(m.group(1))
        ud = re.search(r"[?&]uddg=([^&]+)", href)
        if ud:
            href = urllib.parse.unquote(ud.group(1))
        title = strip_tags(m.group(2))
        if not title or not href.startswith("http"):
            continue  # anomaly/challenge page guard
        results.append({"title": title, "url": href, "snippet": ""})
    snippets = [strip_tags(s.group(1)) for s in
                re.finditer(r'<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</a>', body)]
    for i, sn in enumerate(snippets[:len(results)]):
        results[i]["snippet"] = sn
    if not results and re.search(r"anomaly|challenge|captcha", body, re.I):
        raise RuntimeError("blocked (anomaly page)")
    return results


def _decode_bing_target(url):
    """Decode Bing's base64 target from a /ck/a redirect URL; None if absent."""
    u = re.search(r"[?&]u=a1?([A-Za-z0-9+/=]+)", url)
    if not u:
        return None
    try:
        decoded = base64.b64decode(u.group(1) + "===", validate=False).decode("utf-8", "ignore")
        return decoded if decoded.startswith("http") else None
    except (ValueError, UnicodeDecodeError):
        return None  # not decodable — keep the redirect URL


def engine_bing(ctx):
    params = {"q": ctx["query"]}
    if ctx["lang"] == "zh":
        params.update({"mkt": "zh-CN", "setlang": "zh"})
    elif ctx["lang"] == "en":
        params.update({"mkt": "en-US", "setlang": "en"})
    status, body = http_text("https://www.bing.com/search?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    results = []
    for m in re.finditer(r'<li class="b_algo"[\s\S]*?<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>\s*</h2>([\s\S]*?)</li>', body):
        url = html.unescape(m.group(1))
        url = _decode_bing_target(url) or url
        title = strip_tags(m.group(2))
        snip = strip_tags(m.group(3))[:400]
        if not url.startswith("http") or not title:
            continue
        results.append({"title": title, "url": url, "snippet": snip})
    if not results:
        raise RuntimeError("no results parsed")
    return results


def engine_brave(ctx):
    params = {"q": ctx["query"], "count": str(min(ctx["n"], 20))}
    if ctx["lang"] == "zh":
        params.update({"country": "cn", "search_lang": "zh-hans"})
    status, body = http_text(
        "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode(params),
        headers={"accept": "application/json", "x-subscription-token": ctx["env"]["BRAVE_API_KEY"]},
        timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("web", {}).get("results", [])
    return [{"title": r.get("title", r["url"]), "url": r["url"], "snippet": r.get("description", "")} for r in items]


def engine_tavily(ctx):
    payload = json.dumps({"api_key": ctx["env"]["TAVILY_API_KEY"], "query": ctx["query"],
                          "max_results": min(ctx["n"], 20)}).encode()
    status, body = http_text("https://api.tavily.com/search", method="POST", data=payload,
                             headers={"content-type": "application/json"}, timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("results", [])
    return [{"title": r.get("title", r["url"]), "url": r["url"], "snippet": (r.get("content") or "")[:400]} for r in items]


def engine_serper(ctx):
    payload = {"q": ctx["query"], "num": min(ctx["n"], 20)}
    if ctx["lang"] == "zh":
        payload.update({"gl": "cn", "hl": "zh-cn"})
    status, body = http_text("https://google.serper.dev/search", method="POST",
                             data=json.dumps(payload).encode(),
                             headers={"content-type": "application/json", "x-api-key": ctx["env"]["SERPER_API_KEY"]},
                             timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("organic", [])
    return [{"title": r.get("title", ""), "url": r.get("link", ""), "snippet": r.get("snippet", "")} for r in items]


def engine_exa(ctx):
    payload = {"query": ctx["query"], "numResults": min(ctx["n"], 20)}
    if ctx["days"] > 0:
        payload["startPublishedDate"] = (datetime.datetime.now(datetime.UTC)
                                         - datetime.timedelta(days=ctx["days"])).strftime("%Y-%m-%d")
    status, body = http_text("https://api.exa.ai/search", method="POST",
                             data=json.dumps(payload).encode(),
                             headers={"content-type": "application/json", "x-api-key": ctx["env"]["EXA_API_KEY"]},
                              timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("results", [])
    return [{"title": r.get("title", r["url"]), "url": r["url"],
             "snippet": (r.get("text") or r.get("summary") or "")[:400]} for r in items]


def engine_anysearch(ctx):
    payload = {"query": ctx["query"], "max_results": min(ctx["n"], 20)}
    headers = {"content-type": "application/json"}
    # Key optional — anonymous access works with lower rate limits.
    if ctx["env"].get("ANYSEARCH_API_KEY"):
        headers["authorization"] = f"Bearer {ctx['env']['ANYSEARCH_API_KEY']}"
    status, body = http_text("https://api.anysearch.com/v1/search", method="POST",
                             data=json.dumps(payload).encode(), headers=headers,
                             timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    res = parse_json(body)
    if res.get("code") != 0:
        raise RuntimeError(res.get("message") or f"code {res.get('code')}")
    items = (res.get("data") or {}).get("results", [])
    return [{"title": r.get("title") or r.get("url", ""), "url": r["url"],
             "snippet": (r.get("snippet") or "")[:400]} for r in items if r.get("url")]


def engine_keenable(ctx):
    keyed = bool(ctx["env"].get("KEENABLE_API_KEY"))
    path = "/v1/search" if keyed else "/v1/search/public"
    payload = {"query": ctx["query"], "max_results": min(max(ctx["n"], 1), 50),
               "snippet_max_length": 400}
    headers = {"content-type": "application/json"}
    if keyed:
        headers["x-api-key"] = ctx["env"]["KEENABLE_API_KEY"]
    else:
        headers["x-keenable-title"] = "easy-web-search"  # required for keyless
    status, body = http_text(f"https://api.keenable.ai{path}", method="POST",
                             data=json.dumps(payload).encode(), headers=headers,
                             timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("results", [])
    # cards.keenable.ai URLs are ephemeral (valid one day) — drop them
    return [{"title": r.get("title", ""), "url": r["url"],
             "snippet": (r.get("snippet") or "")[:400]}
            for r in items
            if r.get("url") and not r["url"].startswith("https://cards.keenable.ai/")]


# (name, engine_fn, env_key, flags): baseline engines run by default; keyed
# engines join when their key exists; backup engines also need an explicit
# opt-in (--engine or EASY_WEB_SEARCH_ENGINES) because anonymous quotas are low.
ENGINES = {
    "ddg": (engine_ddg, None, frozenset()),
    "bing": (engine_bing, None, frozenset()),
    "brave": (engine_brave, "BRAVE_API_KEY", frozenset()),
    "tavily": (engine_tavily, "TAVILY_API_KEY", frozenset()),
    "serper": (engine_serper, "SERPER_API_KEY", frozenset()),
    "exa": (engine_exa, "EXA_API_KEY", frozenset()),
    "anysearch": (engine_anysearch, "ANYSEARCH_API_KEY", frozenset({"optional_key", "backup"})),
    "keenable": (engine_keenable, "KEENABLE_API_KEY", frozenset({"optional_key", "backup"})),
}

BACKUP_ENGINES_ENV = "EASY_WEB_SEARCH_ENGINES"


def available_engines(filter_str, env):
    if filter_str:
        names = [s.strip() for s in filter_str.split(",") if s.strip()]
        return [(n, ENGINES[n][0]) for n in names if n in ENGINES]

    def usable(name):
        _, key, flags = ENGINES[name]
        return key is None or env.get(key) or "optional_key" in flags

    engines = [name for name in ENGINES
               if "backup" not in ENGINES[name][2] and usable(name)]
    # Opt-in backups via env (comma-separated), e.g. EASY_WEB_SEARCH_ENGINES=anysearch,keenable
    opt_in = [s.strip() for s in os.environ.get(BACKUP_ENGINES_ENV, "").split(",")
              if s.strip() in ENGINES and "backup" in ENGINES[s.strip()][2]]
    for name in opt_in:
        if name not in engines:
            engines.append(name)
    return [(name, ENGINES[name][0]) for name in engines if usable(name)]


# ---------------------------------------------------------------- fusion ----
def fuse(engine_results):
    by_url = {}
    for name, results in engine_results:
        for idx, r in enumerate(results):
            key = normalize_url(r["url"])
            item = by_url.setdefault(key, {**r, "score": 0.0, "engines": [], "ranks": []})
            item["score"] += 1 / (RRF_K + idx + 1)
            item["engines"].append(name)
            item["ranks"].append(idx + 1)
            if len(item["snippet"]) < len(r["snippet"]):
                item["snippet"] = r["snippet"]
    return sorted(by_url.values(), key=lambda x: -x["score"])


# ------------------------------------------------------------------- main ----
def main():
    p = argparse.ArgumentParser(description="easy-web-search: multi-engine web search")
    p.add_argument("query", nargs="+")
    p.add_argument("-n", "--num", type=int, default=10)
    p.add_argument("--days", type=int, default=0)
    p.add_argument("--site", action="append", default=[])
    p.add_argument("--exclude-site", dest="exclude_site", action="append", default=[])
    p.add_argument("--lang", default="")
    p.add_argument("--engine", default="")
    p.add_argument("--timeout", type=int, default=8)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    env = {k: os.environ[k] for k in
           ("BRAVE_API_KEY", "TAVILY_API_KEY", "SERPER_API_KEY", "EXA_API_KEY")
           if os.environ.get(k)}

    ctx = {"query": build_query(args), "n": args.num, "days": args.days,
           "lang": args.lang.lower(), "timeout": args.timeout, "env": env}
    engines = available_engines(args.engine, env)
    if not engines:
        print("No search engines available. Baseline ddg/bing need network; "
              "keyed engines need their env vars.", file=sys.stderr)
        sys.exit(2)

    statuses = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(engines)) as ex:
        futures = {ex.submit(fn, ctx): name for name, fn in engines}
        for fut in concurrent.futures.as_completed(futures):
            name = futures[fut]
            t0 = time.time()
            try:
                results = fut.result()
                statuses.append({"name": name, "ok": True, "count": len(results),
                                 "ms": int((time.time() - t0) * 1000), "results": results, "error": ""})
            except Exception as e:
                statuses.append({"name": name, "ok": False, "count": 0,
                                 "ms": int((time.time() - t0) * 1000), "results": [], "error": str(e)})

    ok_results = [(s["name"], s["results"]) for s in statuses if s["ok"]]
    fused = fuse(ok_results)[: args.num]

    if args.json:
        print(json.dumps({
            "query": ctx["query"],
            "engines": [{k: s[k] for k in ("name", "ok", "count", "ms", "error")} for s in statuses],
            "results": [{"rank": i + 1, "title": r["title"], "url": r["url"],
                         "snippet": r["snippet"], "score": round(r["score"], 4),
                         "engines": r["engines"]} for i, r in enumerate(fused)],
        }, ensure_ascii=False, indent=2))
    else:
        lines = "\n  ".join(
            f"{s['name']}: {s['count']} results in {s['ms']}ms" if s["ok"]
            else f"{s['name']}: FAILED ({s['error']}) in {s['ms']}ms" for s in statuses)
        print(f"engines:\n  {lines}\n", file=sys.stderr)
        if not fused:
            print("No results from any engine.", file=sys.stderr)
            sys.exit(1)
        for i, r in enumerate(fused, 1):
            print(f"{i}. {r['title']}")
            print(f"   {r['url']}")
            if r["snippet"]:
                print(f"   {r['snippet'][:200]}")
            print(f"   [{', '.join(r['engines'])}]")


if __name__ == "__main__":
    main()
