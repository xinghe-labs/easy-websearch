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
from urllib.request import BaseHandler, HTTPCookieProcessor, ProxyHandler, build_opener

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
RRF_K = 60


_DIRECT_HOSTS = ("baidu.com", "weixin.sogou.com", "sogou.com",
                 "localhost", "127.0.0.1", "::1")


def _force_direct(url: str) -> bool:
    """CN engines and self-hosted/localhost targets must bypass user proxies."""
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in _DIRECT_HOSTS)


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

_FORCE_DIRECT = False


def set_force_direct(v: bool = True) -> None:
    global _FORCE_DIRECT
    _FORCE_DIRECT = v


def http_text(url: str, method: str = "GET", headers: dict | None = None,
              data: bytes | None = None, timeout: float = 8,
              direct: bool = False) -> tuple[int, str]:
    """Fetch an http(s) URL, return (status, body).

    Honors proxy env vars unless `direct` — Chinese engines (baidu/sogou) and
    self-hosted instances must bypass user proxies: proxy exit IPs are
    datacenter-rated and get blocked by CN anti-bot layers (observed)."""
    # Explicit scheme allowlist: only plain http(s) URLs may reach the opener.
    if not url.lower().startswith(("http://", "https://")):
        raise RuntimeError(f"disallowed URL scheme (want http/https): {url[:80]}")
    direct = direct or _FORCE_DIRECT or os.environ.get("EASY_WEB_SEARCH_DIRECT") == "1"
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
    opener = build_opener(ProxyHandler({})) if direct else build_opener()
    opener.add_handler(_HeaderInjector(merged))
    opener.add_handler(HTTPCookieProcessor(COOKIE_JAR))
    try:
        with opener.open(safe_url, data=data if method == "POST" else None,
                         timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")


import time as _time

_RETRYABLE_HTTP = {403, 429, 500, 502, 503, 504}


def retry_http_text(url, method="GET", headers=None, data=None, timeout=8,
                    direct=False, retries=1):
    """http_text with one retry for transient failures (GET only)."""
    for attempt in range(retries + 1):
        try:
            status, body = http_text(url, method=method, headers=headers,
                                     data=data, timeout=timeout, direct=direct)
            if status == 200 or status not in _RETRYABLE_HTTP or attempt >= retries:
                return status, body
        except (RuntimeError, urllib.error.URLError, OSError):
            if attempt >= retries:
                raise
        _time.sleep(0.5 * (attempt + 1))
    raise RuntimeError("unreachable")


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
    opener = build_opener(ProxyHandler({})) if _force_direct(url) else build_opener()
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
def _ddg_params(ctx):
    params = {"q": ctx["query"], "nost": "1"}
    if ctx["lang"] == "zh":
        params["kl"] = "cn-zh"
    elif ctx["lang"] == "en":
        params["kl"] = "us-en"
    if ctx["days"] > 0:
        params["df"] = "d" if ctx["days"] <= 1 else ("w" if ctx["days"] <= 7 else "m")
    return params


def _ddg_push_result(results, href, raw_title):
    """Shared target extraction: html/lite UIs wrap results in /l/?uddg=<enc>."""
    ud = re.search(r"[?&]uddg=([^&]+)", href)
    if ud:
        href = urllib.parse.unquote(ud.group(1))
    title = strip_tags(raw_title)
    if not title or not href.startswith("http"):
        return  # anomaly/challenge page guard
    results.append({"title": title, "url": href, "snippet": ""})


def _parse_ddg_html(ctx, body):
    results = []
    for m in re.finditer(r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', body):
        if len(results) >= ctx["n"] * 2:
            break
        _ddg_push_result(results, html.unescape(m.group(1)), m.group(2))
    snippets = [strip_tags(s.group(1)) for s in
                re.finditer(r'<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</a>', body)]
    for i, sn in enumerate(snippets[:len(results)]):
        results[i]["snippet"] = sn
    if not results:
        if re.search(r"anomaly|challenge|captcha", body, re.I):
            raise RuntimeError("blocked (anomaly page)")
        raise RuntimeError("no results parsed")
    return results


def _parse_ddg_lite(ctx, body):
    """lite UI is table-based; attributes use single quotes and href
    precedes the class: <a href="..." class='result-link'>Title</a> with
    <td class='result-snippet'> cells after each anchor."""
    results = []
    for m in re.finditer(r'<a\b([^>]*result-link[^>]*)>([\s\S]*?)</a>', body):
        if len(results) >= ctx["n"] * 2:
            break
        href_m = re.search(r'href="([^"]+)"', m.group(1)) or re.search(r"href='([^']+)'", m.group(1))
        _ddg_push_result(results, html.unescape(href_m.group(1) if href_m else ""), m.group(2))
    snippets = [strip_tags(s.group(1)) for s in
                re.finditer(r'<td\b[^>]*result-snippet[^>]*>([\s\S]*?)</td>', body)]
    for i, sn in enumerate(snippets[:len(results)]):
        results[i]["snippet"] = sn
    if not results:
        if re.search(r"anomaly|challenge|captcha", body, re.I):
            raise RuntimeError("blocked (anomaly page)")
        raise RuntimeError("no results parsed")
    return results


# Blocks are per-host: html.duckduckgo.com → duckduckgo.com/html → lite
# (a separate table UI). Rotate before failing (and arming a cooldown).
_DD_ENDPOINTS = (
    ("https://html.duckduckgo.com/html/", _parse_ddg_html, "POST"),
    ("https://duckduckgo.com/html/", _parse_ddg_html, "POST"),
    ("https://lite.duckduckgo.com/lite/?", _parse_ddg_lite, "GET"),
)


def engine_ddg(ctx):
    qs = urllib.parse.urlencode(_ddg_params(ctx))
    last_err = None
    for url, parse, method in _DD_ENDPOINTS:
        try:
            if method == "POST":
                status, body = http_text(url, method="POST", data=qs.encode(),
                                         headers={"content-type": "application/x-www-form-urlencoded"},
                                         timeout=ctx["timeout"])
            else:
                # lite serves a GET form; the html UIs take a POST form.
                status, body = http_text(url + qs, timeout=ctx["timeout"])
            if status != 200:
                raise RuntimeError(f"HTTP {status}")
            return parse(ctx, body)
        except (RuntimeError, urllib.error.URLError, OSError) as e:
            last_err = e
    if last_err is None:  # unreachable — the loop always runs ≥ 1 endpoint
        raise RuntimeError("no ddg endpoint attempted")
    raise last_err


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
            any(w in f"{r['title']} {r['url']} {r['snippet']}".lower() for w in words)
            for r in results
        )
        if not any_hit:
            return True
    return False


# Bing serves the same b_algo SERP markup from regional hosts. Blocks and
# bot-junk pages are per-host, so rotate before failing (and arming a
# cooldown): www → cn (CN-tuned, looser for CN queries) → global.
_BING_HOSTS = ("https://www.bing.com", "https://cn.bing.com", "https://global.bing.com")


def _parse_bing_results(ctx, body):
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


def engine_bing(ctx):
    params = {"q": ctx["query"]}
    if ctx["lang"] == "zh":
        params.update({"mkt": "zh-CN", "setlang": "zh"})
    elif ctx["lang"] == "en":
        params.update({"mkt": "en-US", "setlang": "en"})
    qs = urllib.parse.urlencode(params)
    last_err = None
    for host in _BING_HOSTS:
        try:
            status, body = http_text(f"{host}/search?{qs}",
                                     timeout=ctx["timeout"],
                                     headers={"referer": f"{host}/",
                                              "upgrade-insecure-requests": "1"})
            if status != 200:
                raise RuntimeError(f"HTTP {status}")
            results = _parse_bing_results(ctx, body)
            if _looks_like_junk(results, ctx["query"]):
                raise RuntimeError("bot junk detected (results unrelated to query)")
            return results
        except (RuntimeError, urllib.error.URLError, OSError) as e:
            last_err = e
    # All HTML hosts failed — try the RSS pipeline as the last variant.
    # format=rss serves structured XML from a different content pipeline:
    # HTML bot-junk pages don't affect it, and it tolerates bots best.
    try:
        status, body = http_text(f"https://www.bing.com/search?{qs}&format=rss",
                                  timeout=ctx["timeout"],
                                  headers={"referer": "https://www.bing.com/",
                                           "upgrade-insecure-requests": "1"})
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        results = []
        for m in re.finditer(r"<item>([\s\S]*?)</item>", body):
            if len(results) >= ctx["n"] * 2:
                break
            item = re.sub(r"<!\[CDATA\[([\s\S]*?)\]\]>", r"\1", m.group(1))
            tm = re.search(r"<title>([\s\S]*?)</title>", item)
            lm = re.search(r"<link>([\s\S]*?)</link>", item)
            dm = re.search(r"<description>([\s\S]*?)</description>", item)
            title = strip_tags(tm.group(1) if tm else "")
            link = html.unescape(lm.group(1)) if lm else ""
            desc = html.unescape(dm.group(1)) if dm else ""
            if not link.startswith("http") or not title:
                continue
            results.append({"title": title, "url": link, "snippet": desc[:400]})
        if not results:
            raise RuntimeError("no results parsed")
        return results
    except (RuntimeError, urllib.error.URLError, OSError) as e:
        last_err = e
    if last_err is None:  # unreachable — the loop always runs ≥ 1 host
        raise RuntimeError("no bing host attempted")
    raise last_err


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


# Baidu WAF state is per-host. Desktop www first; the mobile SERP
# (m.baidu.com, `word` param) sits behind a looser WAF and serves as the
# fallback. The <h3><a> markup is shared by both UIs.
def _baidu_variants(query: str, rn: str):
    return [
        (f"https://www.baidu.com/s?wd={urllib.parse.quote(query)}&rn={rn}",
         "https://www.baidu.com/"),
        (f"https://m.baidu.com/s?word={urllib.parse.quote(query)}&rn={rn}",
         "https://www.baidu.com/"),
    ]


def _parse_baidu_results(ctx, body):
    results = []
    for m in re.finditer(r'<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', body):
        title = strip_tags(m.group(2))
        if not title or not m.group(1).startswith("http"):
            continue
        results.append({"title": title, "url": html.unescape(m.group(1)), "snippet": ""})
    if not results:
        raise RuntimeError("no results parsed")
    return results


def engine_baidu(ctx):
    rn = str(min(max(ctx["n"], 1), 20))
    last_err = None
    for url, referer in _baidu_variants(ctx["query"], rn):
        try:
            status, body = retry_http_text(url, timeout=ctx["timeout"], direct=True,
                                           headers={"referer": referer})
            if status != 200:
                raise RuntimeError(f"HTTP {status}")
            if "百度安全验证" in body or "wappass" in body:
                raise RuntimeError("baidu anti-bot page (security verification)")
            results = _parse_baidu_results(ctx, body)
            if _looks_like_junk(results, ctx["query"]):
                raise RuntimeError("bot junk detected (results unrelated to query)")
            # Resolve baidu /link wrappers to real targets (fusion dedup needs
            # canonical URLs).
            tops = results[: ctx["n"]]
            for r in tops:
                r["url"] = _resolve_redirect(r["url"], ctx["timeout"])
            return tops
        except (RuntimeError, urllib.error.URLError, OSError) as e:
            last_err = e
    if last_err is None:  # unreachable — the loop always runs ≥ 1 variant
        raise RuntimeError("no baidu variant attempted")
    raise last_err


def _resolve_sogou_links(urls, timeout, base="https://weixin.sogou.com"):
    """Sogou /link pages return a JS stub; the real target is embedded in it."""
    resolved = []
    for u in urls:
        if not u.startswith("/link"):
            resolved.append(u)
            continue
        try:
            full = urllib.parse.urljoin(base, u)
            _, body = http_text(full, timeout=min(timeout, 4), direct=True)
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


def _snippet_after(body: str, from_idx: int, length: int = 200) -> str:
    return strip_tags(body[from_idx:from_idx + 700])[:length]


def _resolve_so360_links(urls, timeout):
    """so.com/link?m= pages redirect via window.location.replace("target")."""
    resolved = []
    for u in urls:
        if not re.search(r"so\.com/link", u):
            resolved.append(u)
            continue
        try:
            _, body = http_text(u, timeout=min(timeout, 4), direct=True)
            m = (re.search(r'window\.location\.replace\("([^"]+)"\)', body) or
                 re.search(r'window\.location\.href\s*=\s*"([^"]+)"', body) or
                 re.search(r"URL='([^']+)'", body))
            if m and m.group(1).startswith("http"):
                resolved.append(m.group(1))
                continue
        except (RuntimeError, urllib.error.URLError, OSError):
            pass  # keep the wrapper URL
        resolved.append(u)
    return resolved


def engine_sogou_web(ctx):
    params = {"query": ctx["query"]}
    status, body = retry_http_text("https://www.sogou.com/web?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"], direct=True,
                             headers={"referer": "https://www.sogou.com/"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    if re.search(r"antispider|验证码|seccode", body, re.I):
        raise RuntimeError("sogou anti-bot page (captcha) — retry later")
    results = []
    for m in re.finditer(r'<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', body):
        title = strip_tags(m.group(2))
        if not title:
            continue
        results.append({"title": title, "url": html.unescape(m.group(1)),
                        "snippet": _snippet_after(body, m.end())})
    if not results:
        raise RuntimeError("no results parsed")
    tops = results[: ctx["n"]]
    urls = _resolve_sogou_links([r["url"] for r in tops], ctx["timeout"],
                                base="https://www.sogou.com")
    for r, u in zip(tops, urls, strict=False):
        r["url"] = u
    return tops


# WAF state is per-host: desktop www first, then the mobile SERP behind a
# looser mobile gate (same res-title titles, but links are jump?u=<enc>
# wrappers on anchors preceding each title, not /link redirects).
def _parse_so360_desktop(ctx, body):
    results = []
    for m in re.finditer(r'<h3[^>]*class="res-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', body):
        title = strip_tags(m.group(2))
        if not title:
            continue
        desc = re.search(r'<p class="res-desc[^"]*"[^>]*>([\s\S]*?)</p>',
                         body[m.start():m.start() + 900])
        results.append({"title": title, "url": html.unescape(m.group(1)),
                        "snippet": strip_tags(desc.group(1))[:300] if desc else ""})
    if not results:
        raise RuntimeError("no results parsed")
    return results


def _parse_so360_mobile(ctx, body):
    results = []
    for m in re.finditer(r'<h3 class="res-title">([\s\S]*?)</h3>', body):
        if len(results) >= ctx["n"] * 2:
            break
        title = strip_tags(m.group(1))
        if not title:
            continue
        # Result URL: the closest jump?u=<enc> wrapper before the title (layout
        # varies by card type; the anchor always precedes the <h3>).
        before = body[max(0, m.start() - 800):m.start()]
        links = re.findall(r'jump\?u=([^"\'&\s]+)', before)
        if not links:
            continue
        url = urllib.parse.unquote(links[-1])
        if not url.startswith("http"):
            continue
        after = body[m.end():m.end() + 600]
        sm = re.search(r'<p class="g-main summary">([\s\S]*?)</p>', after)
        results.append({"title": title, "url": url,
                        "snippet": strip_tags(sm.group(1))[:300] if sm else ""})
    if not results:
        raise RuntimeError("no results parsed")
    return results


_SO360_VARIANTS = (
    (lambda q: f"https://www.so.com/s?q={urllib.parse.quote(q)}", "https://www.so.com/",
     _parse_so360_desktop),
    (lambda q: f"https://m.so.com/s?q={urllib.parse.quote(q)}", "https://m.so.com/",
     _parse_so360_mobile),
)


def engine_so360(ctx):
    last_err = None
    for url_fn, referer, parse in _SO360_VARIANTS:
        try:
            status, body = retry_http_text(url_fn(ctx["query"]), timeout=ctx["timeout"],
                                           direct=True, headers={"referer": referer})
            if status != 200:
                raise RuntimeError(f"HTTP {status}")
            if re.search(r"验证码|wappass", body, re.I):
                raise RuntimeError("so360 anti-bot page (captcha) — retry later")
            results = parse(ctx, body)
            tops = results[: ctx["n"]]
            for r, u in zip(tops, _resolve_so360_links([r["url"] for r in tops], ctx["timeout"]), strict=False):
                r["url"] = u
            return tops
        except (RuntimeError, urllib.error.URLError, OSError) as e:
            last_err = e
    if last_err is None:  # unreachable — the loop always runs ≥ 1 variant
        raise RuntimeError("no so360 variant attempted")
    raise last_err


def engine_sogou_weixin(ctx):
    params = {"type": "2", "query": ctx["query"]}
    status, body = http_text("https://weixin.sogou.com/weixin?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"], direct=True,
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
    urls = _resolve_sogou_links([r["url"] for r in results[: ctx["n"]]], ctx["timeout"],
                                base="https://weixin.sogou.com")
    for r, u in zip(results[: ctx["n"]], urls, strict=False):
        r["url"] = u
    return results[: ctx["n"]]


def _searxng_base_and_auth(raw):
    """Split SEARXNG_BASE_URL into (clean base, optional basic-auth header).

    Supports https://user:pass@host:port forms (needed when the instance sits
    behind a reverse proxy with basic auth). urllib cannot handle userinfo
    URLs itself (observed: 'pass@host' parsed as port) — extract and send the
    Authorization header explicitly instead.
    """
    base = (raw or "").rstrip("/")
    m = re.match(r"^(https?://)([^@/]*)@(.*)$", base)
    if not m:
        return base, ""
    authorization = "Basic " + base64.b64encode(
        urllib.parse.unquote(m.group(2)).encode()
    ).decode()
    return m.group(1) + m.group(3), authorization


# ── Vertical engines (official keyless APIs) — auto-activated by query intent ──

def engine_wikipedia(ctx):
    query = ctx.get("intl_query") or ctx["query"]
    cjk = bool(re.search(r"[\u4e00-\u9fa5]", ctx["query"]))
    lang = ctx["lang"] if ctx["lang"] in ("zh", "en") else ("zh" if cjk else "en")
    params = {"action": "query", "list": "search", "srsearch": ctx["query"],
              "format": "json", "srlimit": str(min(ctx["n"], 10))}
    # Wikipedia via slow proxies sits right at the generic timeout — give it 1.5×.
    status, body = retry_http_text(f"https://{lang}.wikipedia.org/w/api.php?{urllib.parse.urlencode(params)}",
                             timeout=max(ctx["timeout"] * 1.5, 12), headers={"accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("query", {}).get("search", [])
    return [{"title": r["title"],
             "url": f"https://{lang}.wikipedia.org/wiki/{urllib.parse.quote(str(r['title']).replace(' ', '_'))}",
             "snippet": strip_tags(r.get("snippet", ""))} for r in items]


def engine_stack_exchange(ctx):
    query = ctx.get("intl_query") or ctx["query"]
    params = {"intitle": ctx["query"], "site": "stackoverflow",
              "pagesize": str(min(ctx["n"], 10))}
    status, body = retry_http_text("https://api.stackexchange.com/2.3/search/excerpts?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"], headers={"accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("items", [])
    return [{"title": strip_tags(r["title"]),
             "url": f"https://stackoverflow.com/q/{r['question_id']}",
             "snippet": strip_tags(r.get("excerpt", ""))[:300]}
            for r in items if r.get("question_id") and r.get("title")]


def engine_hn(ctx):
    query = ctx.get("intl_query") or ctx["query"]
    params = {"query": ctx["query"], "hitsPerPage": str(min(ctx["n"], 10))}
    status, body = retry_http_text("https://hn.algolia.com/api/v1/search?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"], headers={"accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    hits = parse_json(body).get("hits", [])
    out = []
    for r in hits:
        if not r.get("title"):
            continue
        out.append({"title": r["title"],
                    "url": r.get("url") or f"https://news.ycombinator.com/item?id={r['objectID']}",
                    "snippet": strip_tags(r.get("story_text") or r.get("comment_text") or "")[:300]})
    return out


def engine_github(ctx):
    query = ctx.get("intl_query") or ctx["query"]
    params = {"q": ctx["query"], "per_page": str(min(ctx["n"], 10))}
    status, body = retry_http_text("https://api.github.com/search/repositories?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"],
                             headers={"accept": "application/vnd.github+json"})
    if status == 403:
        raise RuntimeError("GitHub rate limit (10 searches/min unauthenticated) — cooldown covers")
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("items", [])
    return [{"title": f"{r['full_name']} ⭐{r.get('stargazers_count', 0)}",
             "url": r["html_url"],
             "snippet": (r.get("description") or "")[:300]} for r in items]


def engine_juejin(ctx):
    query = ctx.get("intl_query") or ctx["query"]
    params = {"query": ctx["query"], "id_type": "0", "cursor": "0",
              "limit": str(min(ctx["n"], 10))}
    status, body = http_text("https://api.juejin.cn/search_api/v1/search?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"], headers={"accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    d = parse_json(body)
    if d.get("err_no") != 0:
        raise RuntimeError(d.get("err_msg") or f"err_no {d.get('err_no')}")
    out = []
    for item in d.get("data") or []:
        info = (item.get("result_model") or {}).get("article_info") or {}
        if not info.get("title"):
            continue
        out.append({"title": info["title"],
                    "url": f"https://juejin.cn/post/{item['result_model']['article_id']}",
                    "snippet": (info.get("brief_content") or "")[:300]})
        if len(out) >= ctx["n"]:
            break
    return out


def engine_arxiv(ctx):
    query = ctx.get("intl_query") or ctx["query"]
    params = {"search_query": f"all:{ctx['query']}", "max_results": str(min(ctx["n"], 10))}
    status, body = http_text("http://export.arxiv.org/api/query?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"])
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    out = []
    for m in re.finditer(r"<entry>([\s\S]*?)</entry>", body):
        entry = m.group(1)
        tm = re.search(r"<title>([\s\S]*?)</title>", entry)
        im = re.search(r"<id>([\s\S]*?)</id>", entry)
        sm = re.search(r"<summary>([\s\S]*?)</summary>", entry)
        title = strip_tags(tm.group(1)) if tm else ""
        ident = (im.group(1) if im else "").strip()
        if not title or not ident.startswith("http"):
            continue
        out.append({"title": title, "url": ident.replace("http://", "https://"),
                    "snippet": (strip_tags(sm.group(1)) if sm else "")[:300]})
    return out


def engine_mwmbl(ctx):
    status, body = retry_http_text("https://api.mwmbl.org/api/v1/search/?s=" + urllib.parse.quote(ctx["query"]),
                             timeout=ctx["timeout"], headers={"accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body) or []
    out = []
    for r in items[: ctx["n"]]:
        if not r.get("url"):
            continue
        title = "".join(f.get("value", "") for f in (r.get("title") or []))
        extract = "".join(f.get("value", "") for f in (r.get("extract") or []))
        out.append({"title": title or r["url"], "url": r["url"], "snippet": extract[:300]})
    return out


def engine_searxng(ctx):
    raw = os.environ.get("SEARXNG_BASE_URL")
    if not raw:
        raise RuntimeError("SEARXNG_BASE_URL not set — see README SearXNG section")
    base, authorization = _searxng_base_and_auth(raw)
    params = {"q": ctx["query"], "format": "json"}
    if ctx["lang"] == "zh":
        params["language"] = "zh-CN"
    elif ctx["lang"] == "en":
        params["language"] = "en"
    extra = {"accept": "application/json"}
    if authorization:
        extra["authorization"] = authorization
    status, body = http_text(f"{base}/search?{urllib.parse.urlencode(params)}",
                             timeout=ctx["timeout"], direct=True,
                             headers=extra)
    if status == 403:
        raise RuntimeError("SearXNG rejected JSON — add 'json' to search.formats in settings.yml")
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("results", [])[: ctx["n"]]
    return [{"title": r.get("title") or r["url"], "url": r["url"],
             "snippet": (r.get("content") or "")[:400]} for r in items if r.get("url")]


def engine_csdn(ctx):
    query = ctx.get("intl_query") or ctx["query"]
    params = {"q": query, "t": "blog", "p": "1"}
    status, body = http_text("https://so.csdn.net/api/v3/search?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"], direct=True,
                             headers={"accept": "application/json", "referer": "https://www.csdn.net/"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("result_vos", [])
    return [{"title": strip_tags(r["title"]), "url": r["url"],
             "snippet": strip_tags(r.get("description", ""))[:300]}
            for r in items[: ctx["n"]] if r.get("url") and r.get("title")]


def engine_openalex(ctx):
    query = ctx.get("intl_query") or ctx["query"]
    params = {"search": query, "per-page": str(min(ctx["n"], 10))}
    status, body = retry_http_text("https://api.openalex.org/works?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"], headers={"accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("results", [])
    out = []
    for r in items:
        doi_link = (f"https://doi.org/{re.sub(chr(94) + r'https?://doi[.]org/', '', r['doi'])}"
                    if r.get("doi") else r.get("id", ""))
        venue = (r.get("primary_location") or {}).get("source", {}).get("display_name", "")
        out.append({"title": r.get("display_name") or doi_link, "url": doi_link,
                    "snippet": " · ".join(filter(None, [str(r.get("publication_year", "")), venue]))})
    return [r for r in out if r["url"].startswith("http")]


def engine_crossref(ctx):
    query = ctx.get("intl_query") or ctx["query"]
    params = {"query": query, "rows": str(min(ctx["n"], 10))}
    status, body = retry_http_text("https://api.crossref.org/works?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"], headers={"accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("message", {}).get("items", [])
    out = []
    for r in items:
        title = (r.get("title") or [""])[0]
        doi = r.get("DOI", "")
        url = r.get("URL") or (f"https://doi.org/{doi}" if doi else "")
        venue = (r.get("container-title") or [""])[0] or r.get("publisher", "")
        year = ((r.get("issued") or {}).get("date-parts") or [[None]])[0][0] or ""
        out.append({"title": title, "url": url, "snippet": " · ".join(filter(None, [str(year), venue]))})
    return [r for r in out if r["url"] and r["title"]]


def engine_pubmed(ctx):
    query = ctx.get("intl_query") or ctx["query"]
    base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
    params = {"db": "pubmed", "term": query, "retmode": "json", "retmax": str(min(ctx["n"], 10))}
    status, body = retry_http_text(f"{base}/esearch.fcgi?{urllib.parse.urlencode(params)}",
                             timeout=ctx["timeout"], headers={"accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"esearch HTTP {status}")
    ids = parse_json(body).get("esearchresult", {}).get("idlist", [])
    if not ids:
        return []
    params2 = {"db": "pubmed", "id": ",".join(ids), "retmode": "json"}
    status, body = retry_http_text(f"{base}/esummary.fcgi?{urllib.parse.urlencode(params2)}",
                             timeout=ctx["timeout"], headers={"accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"esummary HTTP {status}")
    res = parse_json(body).get("result", {})
    out = []
    for uid in res.get("uids", []):
        doc = res[uid]
        out.append({"title": strip_tags(doc.get("title", "")),
                    "url": f"https://pubmed.ncbi.nlm.nih.gov/{uid}/",
                    "snippet": " · ".join(filter(None, [doc.get("pubdate", ""), doc.get("source", "")]))})
    return out


def engine_huggingface(ctx):
    query = ctx.get("intl_query") or ctx["query"]
    params = {"search": query, "limit": str(min(ctx["n"], 10))}
    status, body = retry_http_text("https://huggingface.co/api/models?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"], headers={"accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body) or []
    out = []
    for r in items[: ctx["n"]]:
        out.append({"title": r.get("id") or r.get("modelId"),
                    "url": f"https://huggingface.co/{r['id']}",
                    "snippet": " · ".join(filter(None, [r.get("pipeline_tag"),
                        f"{r.get('downloads', 0)} downloads", f"{r.get('likes', 0)} likes"]))})
    return out


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
    "wikipedia": (engine_wikipedia, None, frozenset()),
    "stackexchange": (engine_stack_exchange, None, frozenset({"auto"})),
    "github": (engine_github, None, frozenset({"auto"})),
    "hn": (engine_hn, None, frozenset()),
    "juejin": (engine_juejin, None, frozenset()),
    "arxiv": (engine_arxiv, None, frozenset()),
    "mwmbl": (engine_mwmbl, None, frozenset()),
    "csdn": (engine_csdn, None, frozenset()),
    "openalex": (engine_openalex, None, frozenset()),
    "crossref": (engine_crossref, None, frozenset()),
    "pubmed": (engine_pubmed, None, frozenset()),
    "huggingface": (engine_huggingface, None, frozenset()),
    "baidu": (engine_baidu, None, frozenset()),
    "sogouweb": (engine_sogou_web, None, frozenset()),
    "so360": (engine_so360, None, frozenset()),
    "sogouweixin": (engine_sogou_weixin, None, frozenset({"backup"})),
    "anysearch": (engine_anysearch, "ANYSEARCH_API_KEY", frozenset({"optional_key", "backup"})),
    "keenable": (engine_keenable, "KEENABLE_API_KEY", frozenset({"optional_key", "backup"})),
}

BACKUP_ENGINES_ENV = "EASY_WEB_SEARCH_ENGINES"


def _extract_intl_query(query: str) -> str:
    """Extract the longest ASCII keyword run."""
    runs = re.findall(r'[A-Za-z][A-Za-z0-9+#./\/_ -]{2,}', query)
    cleaned = [r.strip() for r in runs if len(r.strip()) >= 3]
    return max(cleaned, key=len) if cleaned else query


def route_auto(query: str) -> dict:
    """Query-intent routing: auto tier engines join on strong signals only."""
    add = []
    q = query.lower()
    if re.search(r"github|gitee|开源仓库|源码|repo\b|open[- ]?source", q):
        add.append("github")
    if re.search(r"stackoverflow|stack\s?exchange|报错|exception|traceback|怎么解决|how to (fix|debug)", q):
        add.append("stackexchange")
    if re.search(r"论文|文献|arxiv|学术|research paper|preprint", q):
        add.extend(["arxiv", "openalex", "crossref", "pubmed"])
    if re.search(r"什么是|百科|维基百科|wikipedia|是谁|who is|history of", q):
        add.append("wikipedia")
    if re.search(r"hacker\s?news|show\s?hn|tech news|科技新闻", q):
        add.append("hn")
    if re.search(r"掘金|juejin|csdn|前端开发|javascript 教程|vue\b|react\b", q):
        add.extend(["juejin", "csdn"])
    if re.search(r"huggingface|数据集|dataset|模型权重|model weights|safetensors|embedding 模型", q):
        add.append("huggingface")
    return {"engines": add, "intl_query": _extract_intl_query(query)}


def available_engines(filter_str, env):
    if filter_str:
        names = [s.strip() for s in filter_str.split(",") if s.strip()]
        return [(n, ENGINES[n][0]) for n in names if n in ENGINES]

    def usable(name):
        _, key, flags = ENGINES[name]
        return key is None or env.get(key) or "optional_key" in flags

    engines = [name for name in ENGINES
               if "backup" not in ENGINES[name][2]
               and "auto" not in ENGINES[name][2]
               and usable(name)]
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
COOLDOWN_MS_FIRST = 2 * 60 * 1000  # transient network blips recover fast
COOLDOWN_MS_MAX = 10 * 60 * 1000   # repeat offenders stay longer


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
    p.add_argument("--direct", action="store_true",
                   help="bypass any proxy for all engines")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

    # Config file: ~/.config/easy-websearch/config.json (CLI flags override)
    _cfg_path = os.path.join(
        os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),
        "easy-websearch", "config.json")
    try:
        with open(_cfg_path, encoding="utf-8") as f:
            _cfg = json.load(f)
    except (OSError, ValueError):
        _cfg = {}
    if not args.lang and _cfg.get("lang"):
        args.lang = _cfg["lang"]
    if args.num == 10 and _cfg.get("n"):
        args.num = _cfg["n"]
    if not args.direct and _cfg.get("direct"):
        args.direct = True
    if not args.engine and _cfg.get("engines"):
        args.engine = _cfg["engines"]

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
    if not args.engine:
        routed = route_auto(ctx["query"])
        for n in routed["engines"]:
            if n not in [e[0] for e in engines] and n in ENGINES:
                engines.append((n, ENGINES[n][0]))
        if routed["engines"]:
            ctx["intl_query"] = routed["intl_query"]
            ctx["query"] = routed["intl_query"]
    elif args.no_cooldown:
        pass  # --no-cooldown implies skip routing too (clean state)
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
        elif state.get(s["name"], {}).get("until", 0) < now_ms + COOLDOWN_MS_MAX:
            # Escalating cooldown: first failure 2 min (transient blips), repeats 10 min.
            failures = int(state.get(s["name"], {}).get("failures", 0)) + 1
            ms = COOLDOWN_MS_FIRST if failures == 1 else COOLDOWN_MS_MAX
            state[s["name"]] = {"until": now_ms + ms,
                                "reason": s["error"][:120], "failures": failures}
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
