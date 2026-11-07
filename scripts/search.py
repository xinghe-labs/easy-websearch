#!/usr/bin/env python3
"""easy-websearch — multi-engine web search with RRF fusion and graceful degradation.

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
from http.cookiejar import CookieJar
from urllib.request import BaseHandler, HTTPCookieProcessor, build_opener

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
RRF_K = 60


class _HeaderInjector(BaseHandler):
    """Apply per-request headers after urllib's built-in defaults.

    AbstractHTTPHandler.do_request_ adds `Content-Type:
    application/x-www-form-urlencoded` to every data-bearing request;
    opener.addheaders entries are applied earlier and lose to it. Handlers
    registered later run later, so overwriting here wins.
    """

    def __init__(self, headers: dict):
        self._headers = headers

    def http_request(self, req):
        for key, value in self._headers.items():
            req.add_unredirected_header(key.capitalize(), value)
        return req

    https_request = http_request


def parse_json(body):
    """json.loads with a per-engine-safe error (callers isolate engines)."""
    try:
        return json.loads(body)
    except ValueError as e:
        raise RuntimeError(f"invalid JSON response: {e}") from e


# Shared cookie jar: search responses often set cookies that later requests
# need (e.g. Sogou /link redirects require SNUID), and keeping them looks
# more browser-like to anti-bot layers.
COOKIE_JAR = CookieJar()


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
    # Headers are injected via a late-running handler: urllib's default
    # `Content-Type: application/x-www-form-urlencoded` for data-bearing
    # requests runs first and addheaders lose to it (observed: Bocha 415).
    # A handler registered after the defaults overwrites that header.
    opener = build_opener()
    opener.add_handler(_HeaderInjector(merged))
    opener.add_handler(HTTPCookieProcessor(COOKIE_JAR))
    try:
        with opener.open(safe_url, data=data if method == "POST" else None,
                         timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")


def http_text_final(url: str, headers: dict | None = None,
                    timeout: float = 8) -> tuple[int, str, str]:
    """GET an http(s) URL and return (status, body, final_url) after redirects."""
    if not url.lower().startswith(("http://", "https://")):
        raise RuntimeError(f"disallowed URL scheme (want http/https): {url[:80]}")
    safe_url: str = urllib.parse.urlunsplit(urllib.parse.urlsplit(url))
    merged = {
        "User-agent": UA,
        "Accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        **(headers or {}),
    }
    opener = build_opener()
    opener.add_handler(_HeaderInjector(merged))
    opener.add_handler(HTTPCookieProcessor(COOKIE_JAR))
    try:
        with opener.open(safe_url, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "ignore"), r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore"), url


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
    if not results:
        if re.search(r"anomaly|challenge|captcha", body, re.I):
            raise RuntimeError("blocked (anomaly page)")
        raise RuntimeError("no results parsed")
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


def _looks_like_junk(results, query):
    """Bing bot-junk guard: under automation pressure Bing serves HTTP 200
    pages of unrelated results (observed: "webgpu" → Google homepage / Baidu
    baike) instead of a clean failure. Detect the classic junk shapes and
    fail soft — the cooldown + other engines take over."""
    if len(results) < 2:
        return False

    def host_of(r):
        try:
            host = urllib.parse.urlsplit(r["url"]).hostname or r["url"]
            return host.removeprefix("www.")
        except ValueError:
            return r["url"]

    def path_of(r):
        try:
            return urllib.parse.urlsplit(r["url"]).path
        except ValueError:
            return None

    # 1) every result on the same domain is a bot page, not an SERP
    if len(results) >= 3 and len({host_of(r) for r in results}) == 1:
        return True
    # 2) real SERPs deep-link; a page of bare homepages is a bot page
    root_count = sum(1 for r in results if path_of(r) in ("", "/"))
    if len(results) >= 2 and root_count >= -(-len(results) * 4 // 5):
        return True
    # 3) latin-script queries: no query word appears in any title/url
    words = re.findall(r"[a-z][a-z0-9+#.-]{2,}", query.lower())
    if words:
        any_hit = any(
            any(w in f"{r['title']} {r['url']}".lower() for w in words)
            for r in results
        )
        if not any_hit:
            return True
    return False


def engine_bing(ctx):
    params = {"q": ctx["query"]}
    if ctx["lang"] == "zh":
        params.update({"mkt": "zh-CN", "setlang": "zh"})
    elif ctx["lang"] == "en":
        params.update({"mkt": "en-US", "setlang": "en"})
    status, body = http_text("https://www.bing.com/search?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"],
                             headers={"referer": "https://www.bing.com/",
                                      "upgrade-insecure-requests": "1"})
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
    if _looks_like_junk(results, ctx["query"]):
        raise RuntimeError("bot junk detected (results unrelated to query)")
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
        headers["x-keenable-title"] = "easy-websearch"  # required for keyless
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


def engine_firecrawl(ctx):
    payload = {"query": ctx["query"], "limit": min(ctx["n"], 20),
               "scrapeOptions": {"formats": ["markdown"]}}
    status, body = http_text("https://api.firecrawl.dev/v1/search", method="POST",
                             data=json.dumps(payload).encode(),
                             headers={"content-type": "application/json",
                                      "authorization": f"Bearer {ctx['env']['FIRECRAWL_API_KEY']}"},
                             timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    res = parse_json(body)
    if res.get("success") is False:
        raise RuntimeError(res.get("error") or "firecrawl error")
    items = res.get("data") if isinstance(res.get("data"), list) else (res.get("data") or {}).get("web", [])
    return [{"title": r.get("title") or r["url"], "url": r["url"],
             "snippet": (r.get("description") or r.get("markdown") or "")[:400]}
            for r in items if r.get("url")]


def engine_bocha(ctx):
    # freshness: noLimit | oneDay | oneWeek | oneMonth | oneYear
    d = ctx["days"]
    freshness = ("noLimit" if d <= 0 else "oneDay" if d <= 1 else
                 "oneWeek" if d <= 7 else "oneMonth" if d <= 31 else "oneYear")
    payload = {"query": ctx["query"], "freshness": freshness, "summary": False,
               "count": min(max(ctx["n"], 1), 50)}
    status, body = http_text("https://api.bochaai.com/v1/web-search", method="POST",
                             data=json.dumps(payload).encode(),
                             headers={"content-type": "application/json",
                                      "authorization": f"Bearer {ctx['env']['BOCHA_API_KEY']}"},
                             timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = ((parse_json(body).get("data") or {}).get("webPages") or {}).get("value", [])
    return [{"title": r.get("name") or r["url"], "url": r["url"],
             "snippet": (r.get("snippet") or "")[:400]} for r in items if r.get("url")]


def engine_metaso(ctx):
    payload = {"mode": "search", "q": ctx["query"], "scope": "webpage",
               "size": str(min(max(ctx["n"], 1), 20)),
               "includeSummary": False, "conciseSnippet": True}
    status, body = http_text("https://metaso.cn/api/v1/search", method="POST",
                             data=json.dumps(payload).encode(),
                             headers={"content-type": "application/json",
                                      "authorization": f"Bearer {ctx['env']['METASO_API_KEY']}"},
                             timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    res = parse_json(body)
    # Error shapes seen in the wild: {"errCode":2005,"errMsg":"API密钥无效"}
    # (curl) and {"code":5000,"message":"系统内部错误"} (urllib) — both
    # wrapped in HTTP 200. Treat any non-success code as an engine error.
    code = res.get("errCode") or res.get("code") or res.get("error")
    if code not in (None, 0, "0", 200, "200", "success"):
        raise RuntimeError(str(res.get("errMsg") or res.get("message") or res.get("error") or code))
    # Response envelope is not formally documented; walk the JSON for the
    # first array of URL-bearing objects (survives shape changes).
    items = []

    def visit(v):
        if not isinstance(v, dict):
            if isinstance(v, list):
                for x in v:
                    visit(x)
            return
        if isinstance(v.get("url"), str) and v["url"].startswith("http"):
            if len(items) < 60:
                items.append(v)
            return
        for x in v.values():
            visit(x)

    visit(res)
    return [{"title": r.get("title") or r.get("name") or r["url"], "url": r["url"],
             "snippet": (r.get("snippet") or r.get("summary") or r.get("content") or "")[:400]}
            for r in items]


def engine_linkup(ctx):
    payload = {"q": ctx["query"], "depth": "standard", "outputType": "searchResults"}
    status, body = http_text("https://api.linkup.so/v1/search", method="POST",
                             data=json.dumps(payload).encode(),
                             headers={"content-type": "application/json",
                                      "authorization": f"Bearer {ctx['env']['LINKUP_API_KEY']}"},
                             timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("results", [])
    return [{"title": r.get("name") or r["url"], "url": r["url"],
             "snippet": (r.get("content") or "")[:400]} for r in items if r.get("url")]


def engine_ollama(ctx):
    payload = {"query": ctx["query"]}
    status, body = http_text("https://ollama.com/api/web_search", method="POST",
                             data=json.dumps(payload).encode(),
                             headers={"content-type": "application/json",
                                      "authorization": f"Bearer {ctx['env']['OLLAMA_API_KEY']}"},
                             timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("results", [])[: ctx["n"]]
    return [{"title": r.get("title") or r["url"], "url": r["url"],
             "snippet": (r.get("content") or "")[:400]} for r in items if r.get("url")]


def _resolve_redirect(url: str, timeout: float) -> str:
    """Follow a redirect chain (baidu /link etc.); return the final URL.

    Baidu's /link endpoint is flaky (observed: 403 on first hit, 200 on
    immediate retry) — require a 200 and retry once.
    """
    for _ in range(2):
        try:
            status, _, final = http_text_final(url, timeout=min(timeout, 5))
            if status == 200 and final.startswith("http") and "baidu.com/link" not in final:
                return final
        except (RuntimeError, urllib.error.URLError, OSError):
            pass  # retry / keep the original URL
    return url


def engine_baidu(ctx):
    params = {"wd": ctx["query"], "rn": str(min(max(ctx["n"], 1), 20))}
    status, body = http_text("https://www.baidu.com/s?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"],
                             headers={"referer": "https://www.baidu.com/"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    if "百度安全验证" in body or "wappass" in body:
        raise RuntimeError("baidu anti-bot page (security verification)")
    results = []
    for m in re.finditer(r'<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', body):
        title = strip_tags(m.group(2))
        if not title or not m.group(1).startswith("http"):
            continue
        results.append({"title": title, "url": html.unescape(m.group(1)), "snippet": ""})
    if not results:
        raise RuntimeError("no results parsed")
    if _looks_like_junk(results, ctx["query"]):
        raise RuntimeError("bot junk detected (results unrelated to query)")
    # Resolve baidu /link wrappers to real targets (fusion dedup needs
    # canonical URLs).
    tops = results[: ctx["n"]]
    for r in tops:
        r["url"] = _resolve_redirect(r["url"], ctx["timeout"])
    return tops


def _resolve_sogou_links(urls, timeout):
    """Sogou /link pages return a JS stub; the real target is embedded in it."""
    resolved = []
    for u in urls:
        if not u.startswith("/link"):
            resolved.append(u)
            continue
        try:
            full = urllib.parse.urljoin("https://weixin.sogou.com", u)
            _, body = http_text(full, timeout=min(timeout, 4))
            # Stub:  url += 'https://mp.';  url += 'weixin.qq.c';  …
            target = "".join(m.group(1) for m in
                             re.finditer(r"url\s*\+=\s*'([^']*)'", body))
            target = re.sub(r"@.*$", "", target)
            if target.startswith("http"):
                resolved.append(target)
                continue
            alt = re.search(r'window\.location\.replace\("([^"]+)"\)', body)
            if alt and alt.group(1).startswith("http"):
                resolved.append(alt.group(1))
                continue
        except (RuntimeError, urllib.error.URLError, OSError):
            pass  # keep the /link URL
        resolved.append(u)
    return resolved


def engine_sogou_weixin(ctx):
    params = {"type": "2", "query": ctx["query"]}
    status, body = http_text("https://weixin.sogou.com/weixin?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"],
                             headers={"referer": "https://weixin.sogou.com/"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    if re.search(r"antispider|验证码|seccode", body, re.I):
        raise RuntimeError("sogou anti-bot page (captcha) — retry later")
    results = []
    for m in re.finditer(r'<h3>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', body):
        title = strip_tags(m.group(2))
        if not title:
            continue
        results.append({"title": title, "url": html.unescape(m.group(1)), "snippet": ""})
    if not results:
        raise RuntimeError("no results parsed")
    urls = _resolve_sogou_links([r["url"] for r in results[: ctx["n"]]], ctx["timeout"])
    for r, u in zip(results[: ctx["n"]], urls, strict=False):
        r["url"] = u
    return results[: ctx["n"]]


def engine_searxng(ctx):
    base = (os.environ.get("SEARXNG_BASE_URL") or "").rstrip("/")
    params = {"q": ctx["query"], "format": "json"}
    if ctx["lang"] == "zh":
        params["language"] = "zh-CN"
    elif ctx["lang"] == "en":
        params["language"] = "en"
    status, body = http_text(f"{base}/search?{urllib.parse.urlencode(params)}",
                             timeout=ctx["timeout"],
                             headers={"accept": "application/json"})
    if status == 403:
        raise RuntimeError("SearXNG rejected JSON — add 'json' to search.formats in settings.yml")
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("results", [])[: ctx["n"]]
    return [{"title": r.get("title") or r["url"], "url": r["url"],
             "snippet": (r.get("content") or "")[:400]} for r in items if r.get("url")]


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
    "firecrawl": (engine_firecrawl, "FIRECRAWL_API_KEY", frozenset()),
    "bocha": (engine_bocha, "BOCHA_API_KEY", frozenset()),
    "metaso": (engine_metaso, "METASO_API_KEY", frozenset()),
    "linkup": (engine_linkup, "LINKUP_API_KEY", frozenset()),
    "ollama": (engine_ollama, "OLLAMA_API_KEY", frozenset()),
    "searxng": (engine_searxng, "SEARXNG_BASE_URL", frozenset()),
    "baidu": (engine_baidu, None, frozenset()),
    "sogouweixin": (engine_sogou_weixin, None, frozenset({"backup"})),
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


# ------------------------------------------------------- cooldown ----
# Engines that just failed get a cooldown: default runs skip them (they
# would likely fail again and burn the request budget). Explicit --engine
# and --no-cooldown bypass the skip. State persists across invocations in
# the user's cache dir; IO failures degrade silently to no cooldown.
COOLDOWN_MS = 10 * 60 * 1000


def _cooldown_path() -> str:
    base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(base, "easy-websearch", "cooldowns.json")


def _load_cooldowns() -> dict:
    try:
        with open(_cooldown_path(), encoding="utf-8") as f:
            state = json.load(f)
            return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_cooldowns(state: dict) -> None:
    try:
        os.makedirs(os.path.dirname(_cooldown_path()), exist_ok=True)
        with open(_cooldown_path(), "w", encoding="utf-8") as f:
            json.dump(state, f)
    except OSError:
        pass  # best effort — cooldown is an optimization, not a guarantee


# ------------------------------------------------------------------- main ----
def main():
    p = argparse.ArgumentParser(description="easy-websearch: multi-engine web search")
    p.add_argument("query", nargs="+")
    p.add_argument("-n", "--num", type=int, default=10)
    p.add_argument("--days", type=int, default=0)
    p.add_argument("--site", action="append", default=[])
    p.add_argument("--exclude-site", dest="exclude_site", action="append", default=[])
    p.add_argument("--lang", default="")
    p.add_argument("--engine", default="")
    p.add_argument("--timeout", type=int, default=8)
    p.add_argument("--no-cooldown", action="store_true")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    env = {k: os.environ[k] for k in
           ("BRAVE_API_KEY", "TAVILY_API_KEY", "SERPER_API_KEY", "EXA_API_KEY",
            "FIRECRAWL_API_KEY", "BOCHA_API_KEY", "METASO_API_KEY", "LINKUP_API_KEY",
            "OLLAMA_API_KEY", "ANYSEARCH_API_KEY", "KEENABLE_API_KEY",
            "SEARXNG_BASE_URL")
           if os.environ.get(k)}

    ctx = {"query": build_query(args), "n": args.num, "days": args.days,
           "lang": args.lang.lower(), "timeout": args.timeout, "env": env}
    engines = available_engines(args.engine, env)
    if args.engine:
        requested = [s.strip() for s in args.engine.split(",") if s.strip()]
        unknown = [n for n in requested if n not in ENGINES]
        if unknown:
            print(f"Unknown engine(s): {', '.join(unknown)}\n"
                  f"Valid engines: {', '.join(ENGINES)}", file=sys.stderr)
            sys.exit(2)
    if not engines:
        print("No search engines available (baseline ddg/bing need network; "
              "keyed engines need their env vars).\n"
              f"Valid engines: {', '.join(ENGINES)}", file=sys.stderr)
        sys.exit(2)

    # Skip engines in active cooldown (default selection only; explicit
    # --engine always wins). Never skip down to zero engines.
    state = {} if args.no_cooldown else _load_cooldowns()
    now_ms = int(time.time() * 1000)
    names = [n for n, _ in engines]
    in_cooldown = [n for n in names if state.get(n, {}).get("until", 0) > now_ms]
    cooldown_skipped = []
    if not args.engine and in_cooldown and len(in_cooldown) < len(engines):
        for n in in_cooldown:
            cooldown_skipped.append({"name": n, "ok": False, "count": 0, "ms": 0,
                                     "error": f"skipped (cooldown: {state[n].get('reason', 'recent failure')})"})
        engines = [(n, fn) for n, fn in engines if n not in in_cooldown]

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

    # Persist cooldown bookkeeping: successes clear, failures arm a cooldown.
    dirty = False
    for s in statuses:
        if s["ok"]:
            if s["name"] in state:
                del state[s["name"]]
                dirty = True
        elif state.get(s["name"], {}).get("until", 0) < now_ms + COOLDOWN_MS:
            state[s["name"]] = {"until": now_ms + COOLDOWN_MS,
                                "reason": s["error"][:120]}
            dirty = True
    if dirty and not args.no_cooldown:
        _save_cooldowns(state)

    # --days is not supported by every engine — say so instead of silently
    # ignoring it.
    if ctx["days"] > 0:
        for s in statuses:
            if s["name"] == "bing" and s["ok"]:
                s["note"] = "days ignored by bing"

    all_engines = cooldown_skipped + statuses
    fused = fuse(ok_results)[: args.num]

    if args.json:
        print(json.dumps({
            "query": ctx["query"],
            "engines": [{k: s[k] for k in ("name", "ok", "count", "ms", "error", "note") if k in s} for s in all_engines],
            "results": [{"rank": i + 1, "title": r["title"], "url": r["url"],
                         "snippet": r["snippet"], "score": round(r["score"], 4),
                         "engines": r["engines"]} for i, r in enumerate(fused)],
        }, ensure_ascii=False, indent=2))
    else:
        lines = "\n  ".join(
            f"{s['name']}: {s['count']} results in {s['ms']}ms" + (f" [{s['note']}]" if s.get('note') else "") if s["ok"]
            else f"{s['name']}: {s['error']}" if s["error"].startswith("skipped")
            else f"{s['name']}: FAILED ({s['error']}) in {s['ms']}ms" for s in all_engines)
        print(f"engines:\n  {lines}\n")
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
