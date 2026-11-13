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
import contextlib
import datetime
import html
import json
import os
import re
import sys
import time
import time as _time
import urllib.error
import urllib.parse
from http.cookiejar import CookieJar
from urllib.request import BaseHandler, HTTPCookieProcessor, ProxyHandler, build_opener

from extra_engines import build_extra_engines

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
RRF_K = 60

# Academic indexes only pay off for academic questions. For everything else they
# answer a multi-word query with one keyword and inject unrelated papers
# (measured: "webgpu 浏览器支持情况" returned a Selenium VS-Code paper and a
# campus-tour paper). Their contribution is halved unless the query looks
# academic — coverage kept, dominance removed.


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


# Tracking parameters that never change the document — dropping them is what
# lets two URLs for the same article fuse into one hit. CSDN
# (ops_request_misc / request_id / biz_id) and Alibaba/WeChat share links
# produced real duplicates in testing.
TRACKING_PARAM = re.compile(
    r"^(utm_|ref|fbclid|gclid|msclkid|yclid|ops_request_misc|request_id|biz_id"
    r"|spm|scm|scene|isappinstalled|clicktime|enterid|share_token|share_source"
    r"|from_source|trk)",
    re.I,
)


def normalize_url(u):
    try:
        x = urllib.parse.urlsplit(u)
        query = [(k, v) for k, v in urllib.parse.parse_qsl(x.query)
                 if not TRACKING_PARAM.match(k)]
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


# Interrogatives carry no topical signal — a SERP that only matches "如何" is
# still answering a different question.
CJK_STOP_BIGRAMS = frozenset({
    "如何", "什么", "怎么", "怎样", "哪些", "哪个", "可以", "是否", "为什", "么样",
    "我们", "你们", "他们", "这个", "那个", "一个", "有没", "没有", "需要",
})


def _cjk_bigrams(s):
    out = set()
    for seg in re.sub(r"[^\u4e00-\u9fa5]+", " ", s or "").split(" "):
        for i in range(len(seg) - 1):
            out.add(seg[i:i + 2])
    return out


# Scraped SERP engines are where bot junk comes from: under load bing answers a
# Chinese query with Korean forum spam, adult listings or a bare site name. The
# content engines (examcp/parallelmcp/degoog) are semantically matched and are
# never touched by this rule.
SCRAPED_SERP = frozenset({"ddg", "bing", "baidu", "sogouweb", "so360"})


def _is_off_topic_scraped_hit(r, query):
    """Validated on a hand-checked corpus (5 queries / 50 results): 8 junk
    dropped, 0 legitimate hits lost."""
    if not all(e in SCRAPED_SERP for e in r["engines"]):
        return False
    title = r.get("title") or ""
    lower = title.lower()
    latin = re.findall(r"[a-z][a-z0-9+#.-]{2,}", query.lower())
    if latin and any(w in lower for w in latin):
        return False
    if not re.search(r"[\u4e00-\u9fa5]", query):
        return False
    # Script mismatch: Korean/Japanese page for a Chinese query.
    if re.search(r"[\uac00-\ud7af]", title) and not re.search(r"[\uac00-\ud7af]", query):
        return True
    if re.search(r"[\u3040-\u30ff]", title) and not re.search(r"[\u3040-\u30ff]", query):
        return True
    # Latin-only title with no query term ("Web of Science").
    if not re.search(r"[\u4e00-\u9fa5]", title):
        return True
    # Chinese title that shares no 2-char run with the query.
    qb = [b for b in _cjk_bigrams(query) if b not in CJK_STOP_BIGRAMS]
    return bool(qb) and not any(b in _cjk_bigrams(title) for b in qb)


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
            any(w in f"{r['title']} {r['url']} {r.get('snippet', '')}".lower() for w in words)
            for r in results
        )
        if not any_hit:
            return True
    # 4) CJK queries: under the same pressure bing degrades a multi-word query
    # to its first character and serves a plausible SERP for that
    # ("大模型 论文 综述" -> ten dictionary entries for 大). If no title shares
    # a 2-char run with the query and no latin query word appears, the whole
    # SERP answers something else.
    if re.search(r"[\u4e00-\u9fa5]", query):
        qb = [b for b in _cjk_bigrams(query) if b not in CJK_STOP_BIGRAMS]
        if qb:
            latin = re.findall(r"[a-z][a-z0-9+#.-]{2,}", query.lower())

            def title_matches(r):
                t = r.get("title") or ""
                if any(w in t.lower() for w in latin):
                    return True
                tb = _cjk_bigrams(t)
                return any(b in tb for b in qb)

            if not any(title_matches(r) for r in results):
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


def _parse_bing_rss(ctx, body):
    """RSS fallback: format=rss serves structured XML from a different content
    pipeline — HTML bot-junk pages don't affect it, and it tolerates bots best.
    <link> carries the direct target (no /ck/a wrapper)."""
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
        results.append({"title": title, "url": link, "snippet": strip_tags(desc)[:400]})
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
    try:
        status, body = http_text(f"https://www.bing.com/search?{qs}&format=rss",
                                  timeout=ctx["timeout"],
                                  headers={"referer": "https://www.bing.com/",
                                           "upgrade-insecure-requests": "1"})
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        return _parse_bing_rss(ctx, body)
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


# Exa's free MCP endpoint — no API key, same backend the built-in web_search
# uses. Returns real page highlights instead of a bare SERP. Rate-limited (429)
# on the shared free tier, so it fails soft like everything else.
EXA_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa"


def _parse_exa_mcp_text(ctx, text: str) -> list:
    out = []
    # Blocks are separated by a line starting with "Title: ".
    for block in re.split(r"(?=^Title: )", text, flags=re.M):
        title = re.search(r"^Title: (.*)$", block, flags=re.M)
        url = re.search(r"^URL: (\S+)$", block, flags=re.M)
        if not title or not url:
            continue
        hl = re.split(r"^Highlights:\s*$", block, maxsplit=1, flags=re.M)
        snippet = re.sub(r"\s+", " ", hl[1] if len(hl) > 1 else "").strip()[:400]
        out.append({"title": title.group(1).strip(), "url": url.group(1).strip(),
                    "snippet": snippet})
        if len(out) >= ctx["n"]:
            break
    if not out:
        raise RuntimeError("no results parsed")
    return out


# Parallel's free MCP endpoint — no API key, returns real page excerpts (same
# class as examcp). Two gotchas: the default urllib User-Agent is rate-limited
# by their free tier, and the payload nests a JSON string inside content[0].text.
PARALLEL_MCP_URL = "https://search.parallel.ai/mcp"


def engine_parallel_mcp(ctx):
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
               "params": {"name": "web_search",
                          "arguments": {"objective": ctx["query"],
                                        "search_queries": [ctx["query"]]}}}
    status, body = http_text(PARALLEL_MCP_URL, method="POST",
                             data=json.dumps(payload).encode(),
                             headers={"content-type": "application/json",
                                      "accept": "application/json, text/event-stream",
                                      # Their free tier 429s the default urllib agent.
                                      "user-agent": "easy-websearch"},
                             timeout=max(ctx["timeout"], 20))
    if status == 429:
        raise RuntimeError("Parallel MCP rate limit (free tier) — retry later or set PARALLEL_API_KEY")
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    try:
        outer = json.loads(body)
        text = outer["result"]["content"][0]["text"]
        inner = json.loads(text)
    except (ValueError, KeyError, IndexError, TypeError):
        raise RuntimeError("no results parsed") from None
    out = []
    for r in inner.get("results", []) or []:
        if not r.get("url") or not r.get("title"):
            continue
        excerpt = " ".join(r.get("excerpts") or [])
        out.append({"title": r["title"], "url": r["url"],
                    "snippet": re.sub(r"\s+", " ", excerpt).strip()[:400]})
        if len(out) >= ctx["n"]:
            break
    if not out:
        raise RuntimeError("no results parsed")
    return out


# degoog public instance — keyless Google results (optional DEGOOG_API_KEY for
# instances that protect their search route).
def engine_degoog(ctx):
    base = (os.environ.get("DEGOOG_URL") or "https://degoog.org").rstrip("/")
    headers = {"content-type": "application/json", "accept": "application/json"}
    key = os.environ.get("DEGOOG_API_KEY")
    if key:
        headers["authorization"] = f"Bearer {key}"
    status, body = http_text(f"{base}/api/search", method="POST",
                             data=json.dumps({"query": ctx["query"], "type": "web", "page": 1}).encode(),
                             headers=headers, timeout=max(ctx["timeout"], 15))
    if status == 401:
        raise RuntimeError("degoog instance protects /api/search — set DEGOOG_API_KEY or DEGOOG_URL")
    if status == 429:
        raise RuntimeError("degoog rate limit (public instance) — retry later or set DEGOOG_API_KEY")
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("results", []) or []
    out = [{"title": r["title"], "url": r["url"], "snippet": str(r.get("snippet") or "")[:400]}
           for r in items if r.get("url") and r.get("title")]
    if not out:
        raise RuntimeError("no results parsed")
    return out[: ctx["n"]]


# ── Keyless MCP verticals ────────────────────────────────────────────────
# deepwiki (GitHub repo Q&A) and context7 (library docs) answer over the same
# JSON-RPC shape as exa/parallel; both are free and need no key.
DEEPWIKI_MCP = "https://mcp.deepwiki.com/mcp"
CONTEXT7_MCP = "https://mcp.context7.com/mcp"


def _mcp_call(url, tool_name, arguments, timeout=25):
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
               "params": {"name": tool_name, "arguments": arguments}}
    status, body = http_text(url, method="POST", data=json.dumps(payload).encode(),
                             headers={"content-type": "application/json",
                                      "accept": "application/json, text/event-stream",
                                      "user-agent": "easy-websearch"},
                             timeout=timeout)
    if status == 429:
        raise RuntimeError("MCP rate limit (429) — retry later")
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    # Servers answer with plain JSON or with SSE frames — and a streaming server
    # may emit several frames per call, so parse each frame and keep the last one
    # that is actually JSON (joining frames would produce invalid JSON).
    parsed = None
    if "data:" in body:
        for line in body.split("\n"):
            if not line.startswith("data:"):
                continue
            try:
                frame = json.loads(line[5:].strip())
            except ValueError:
                continue
            if isinstance(frame, dict) and (frame.get("result") or frame.get("error")):
                parsed = frame
    if parsed is None:
        try:
            parsed = json.loads(body)
        except ValueError:
            raise RuntimeError("invalid JSON from MCP") from None
    if parsed.get("error"):
        raise RuntimeError(parsed["error"].get("message") or "MCP error")
    content = (parsed.get("result") or {}).get("content") or []
    return content[0].get("text", "") if content else ""


def engine_deepwiki(ctx):
    m = re.search(r"\b([\w.-]+/[\w.-]+)\b", ctx["query"])
    if not m:
        raise RuntimeError("no owner/repo in query")
    repo = m.group(1)
    text = _mcp_call(DEEPWIKI_MCP, "ask_wiki_question", {"repoName": repo, "question": ctx["query"]})
    if not text:
        raise RuntimeError("no results parsed")
    link = re.search(r"https://deepwiki\.com/\S+", text)
    return [{"title": f"DeepWiki · {repo}",
             "url": link.group(0) if link else f"https://deepwiki.com/{repo}",
             "snippet": re.sub(r"\s+", " ", text).strip()[:400]}]


def engine_context7(ctx):
    resolved = _mcp_call(CONTEXT7_MCP, "resolve-library-id",
                         {"libraryName": ctx["query"], "query": ctx["query"]})
    m = re.search(r"library ID:\s*(/[\w./-]+)", resolved, re.I) or re.search(r"(/[\w.-]+/[\w.-]+)", resolved)
    if not m:
        raise RuntimeError("no results parsed")
    lib_id = m.group(1)
    docs = _mcp_call(CONTEXT7_MCP, "query-docs", {"libraryId": lib_id, "query": ctx["query"]})
    out = []
    for block in re.split(r"(?=^### )", docs, flags=re.M):
        src = re.search(r"Source:\s*(https?://\S+)", block, re.I)
        if not src:
            continue
        heading = re.search(r"^###\s+(.+)$", block, re.M)
        body = re.sub(r"Source:\s*\S+", "", block, flags=re.I)
        body = re.sub(r"^###.*$", "", body, flags=re.M)
        out.append({"title": f"{(heading.group(1) if heading else src.group(1)).strip()} — {lib_id}",
                    "url": src.group(1),
                    "snippet": re.sub(r"\s+", " ", body).strip()[:400]})
        if len(out) >= ctx["n"]:
            break
    if not out:
        out.append({"title": f"Context7 · {lib_id}", "url": f"https://context7.com{lib_id}",
                    "snippet": re.sub(r"\s+", " ", docs).strip()[:400]})
    return out


def engine_examcp(ctx):
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
               "params": {"name": "web_search_exa",
                          "arguments": {"query": ctx["query"], "numResults": min(ctx["n"], 10)}}}
    status, body = http_text(EXA_MCP_URL, method="POST",
                             data=json.dumps(payload).encode(),
                             headers={"content-type": "application/json",
                                      "accept": "application/json, text/event-stream",
                                      "x-exa-source": "easy-websearch"},
                             timeout=max(ctx["timeout"], 15))
    if status == 429:
        raise RuntimeError("Exa MCP rate limit (free tier) — retry later or set EXA_API_KEY")
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    # Server-sent events: keep the last frame that actually carries a result.
    text = ""
    for line in body.split("\n"):
        if not line.startswith("data:"):
            continue
        try:
            frame = json.loads(line[5:].strip())
        except ValueError:
            continue
        if isinstance(frame, dict) and frame.get("result"):
            content = frame["result"].get("content") or []
            if content and isinstance(content[0], dict) and content[0].get("text"):
                text = content[0]["text"]
    if not text:
        raise RuntimeError("no results parsed")
    return _parse_exa_mcp_text(ctx, text)


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
    # The window can cut a tag in half, and sogou embeds thumbnail <img>
    # markup in result blurbs. Drop image markup and any dangling partial tag
    # BEFORE stripping, or raw "<img src=..." leaks through.
    def window_text(n: int) -> str:
        s = body[from_idx:from_idx + n]
        nxt = re.search(r"<h3\b", s, re.IGNORECASE)  # never bleed into next result
        if nxt and nxt.start() > 0:
            s = s[:nxt.start()]
        s = re.sub(r"<img\b[^>]*>", " ", s, flags=re.IGNORECASE)
        s = re.sub(r"<[^>]*$", " ", s)
        return strip_tags(s)

    text = window_text(700)
    # A blurb that is mostly thumbnail leaves nothing behind — look wider.
    if len(text) < 20:
        text = window_text(1600)
    return text[:length]


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
    cjk = bool(re.search(r"[\u4e00-\u9fa5]", query))
    lang = ctx["lang"] if ctx["lang"] in ("zh", "en") else ("zh" if cjk else "en")
    params = {"action": "query", "list": "search", "srsearch": query,
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
    params = {"intitle": query, "site": "stackoverflow",
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
    params = {"query": query, "hitsPerPage": str(min(ctx["n"], 10))}
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
    params = {"q": query, "per_page": str(min(ctx["n"], 10))}
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
    params = {"query": query, "id_type": "0", "cursor": "0",
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
    params = {"search_query": f"all:{query}", "max_results": str(min(ctx["n"], 10))}
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


# ── Owner-requested expansion (v1.9, probe evidence in engine-notes) ──

# Google Custom Search JSON API — free 100 queries/day, official Google
# results. Needs BOTH GOOGLE_API_KEY and a Programmable Search Engine cx.
def engine_google_cse(ctx):
    cx = ctx["env"].get("GOOGLE_CX")
    if not cx:
        raise RuntimeError("GOOGLE_CX not set — create a search engine at "
                           "programmablesearchengine.google.com and put its id in GOOGLE_CX")
    params = {"key": ctx["env"].get("GOOGLE_API_KEY"), "cx": cx, "q": ctx["query"],
              "num": str(min(max(ctx["n"], 1), 10))}
    if ctx["lang"] == "zh":
        params["hl"] = "zh-CN"
    elif ctx["lang"] == "en":
        params["hl"] = "en"
    status, body = http_text("https://www.googleapis.com/customsearch/v1?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"], headers={"accept": "application/json"})
    if status != 200:
        msg = ""
        # error.message survives shape changes; suppress non-dict JSON (AttributeError)
        # and parse failures alike.
        with contextlib.suppress(RuntimeError, ValueError, AttributeError):
            msg = ": " + str(parse_json(body).get("error", {}).get("message", ""))[:100]
        raise RuntimeError(f"HTTP {status}{msg}")
    items = parse_json(body).get("items", [])
    return [{"title": r["title"], "url": r["link"], "snippet": (r.get("snippet") or "")[:400]}
            for r in items if r.get("link") and r.get("title")]


# Semantic Scholar Graph API — free, keyless (shared per-IP anonymous pool,
# often 429 from proxy/datacenter exits); a free S2_API_KEY lifts the limit.
def engine_semantic_scholar(ctx):
    params = {"query": ctx["query"], "limit": str(min(ctx["n"], 10)),
              "fields": "title,url,year,venue,citationCount"}
    headers = {"accept": "application/json"}
    if ctx["env"].get("S2_API_KEY"):
        headers["x-api-key"] = ctx["env"]["S2_API_KEY"]
    status, body = http_text("https://api.semanticscholar.org/graph/v1/paper/search?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"], headers=headers)
    if status == 429:
        raise RuntimeError("Semantic Scholar rate limit (shared anonymous pool) — "
                           "retry later or set S2_API_KEY (free)")
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body).get("data", [])
    out = []
    for r in items:
        if not (r.get("url") and r.get("title")):
            continue
        meta = " · ".join(filter(None, [str(r.get("year", "")), r.get("venue", ""),
            f"{r['citationCount']} citations" if r.get("citationCount") is not None else ""]))
        out.append({"title": r["title"], "url": r["url"], "snippet": meta})
    return out


# Bing News RSS — keyless, CN-reachable. Item links are apiclick.aspx
# wrappers carrying the real target in the url= param (observed 2026-11-09);
# News:Source carries the publisher.
def _parse_bing_news_rss(ctx, body):
    results = []
    for m in re.finditer(r"<item>([\s\S]*?)</item>", body):
        if len(results) >= ctx["n"] * 2:
            break
        item = re.sub(r"<!\[CDATA\[([\s\S]*?)\]\]>", r"\1", m.group(1))
        tm = re.search(r"<title>([\s\S]*?)</title>", item)
        lm = re.search(r"<link>([\s\S]*?)</link>", item)
        sm = re.search(r"<News:Source>([\s\S]*?)</News:Source>", item)
        dm = re.search(r"<pubDate>([\s\S]*?)</pubDate>", item)
        title = strip_tags(tm.group(1) if tm else "")
        link = html.unescape(lm.group(1)) if lm else ""
        # url= is the last param and carries the raw target — take the rest greedily.
        up = re.search(r"[?&]url=(.+)$", link)
        url = urllib.parse.unquote(up.group(1)) if up else link
        source = strip_tags(sm.group(1)) if sm else ""
        date = strip_tags(dm.group(1)) if dm else ""
        if not url.startswith("http") or not title:
            continue
        results.append({"title": title, "url": url,
                        "snippet": " · ".join(filter(None, [source, date]))})
    if not results:
        raise RuntimeError("no results parsed")
    return results


def engine_bing_news(ctx):
    params = {"q": ctx["query"], "format": "rss"}
    if ctx["lang"] == "zh":
        params["setmkt"] = "zh-CN"
    elif ctx["lang"] == "en":
        params["setmkt"] = "en-US"
    status, body = http_text("https://www.bing.com/news/search?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"],
                             headers={"referer": "https://www.bing.com/",
                                      "upgrade-insecure-requests": "1"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    return _parse_bing_news_rss(ctx, body)


# Gitee API v5 — anonymous search returns EMPTY arrays (observed 2026-11-09),
# so this engine is gated on a free GITEE_TOKEN. Routed only when the token
# exists (see route_auto) to keep token-less runs noise-free.
def engine_gitee(ctx):
    params = {"q": ctx["query"], "per_page": str(min(ctx["n"], 10)),
              "access_token": ctx["env"].get("GITEE_TOKEN")}
    status, body = http_text("https://gitee.com/api/v5/search/repositories?" + urllib.parse.urlencode(params),
                             timeout=ctx["timeout"], headers={"accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    items = parse_json(body) or []
    out = []
    for r in items:
        if not (r.get("html_url") and (r.get("full_name") or r.get("human_name"))):
            continue
        name = r.get("human_name") or r.get("full_name")
        out.append({"title": f"{name} ⭐{r.get('stargazers_count', 0)}",
                    "url": r["html_url"],
                    "snippet": (r.get("description") or "")[:300]})
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
    # Keyless Exa MCP (free tier) — the backend the built-in web_search uses.
    "examcp": (engine_examcp, None, frozenset()),
    # Keyless Parallel MCP (free tier) — page excerpts, like examcp.
    "parallelmcp": (engine_parallel_mcp, None, frozenset()),
    # Keyless MCP verticals: repo Q&A and library docs (auto tier).
    "deepwiki": (engine_deepwiki, None, frozenset({"auto"})),
    "context7": (engine_context7, None, frozenset({"auto"})),
    # Keyless degoog public instance — Google results.
    "degoog": (engine_degoog, None, frozenset()),
    "firecrawl": (engine_firecrawl, "FIRECRAWL_API_KEY", frozenset()),
    "bocha": (engine_bocha, "BOCHA_API_KEY", frozenset()),
    "metaso": (engine_metaso, "METASO_API_KEY", frozenset()),
    "linkup": (engine_linkup, "LINKUP_API_KEY", frozenset()),
    "ollama": (engine_ollama, "OLLAMA_API_KEY", frozenset()),
    "searxng": (engine_searxng, "SEARXNG_BASE_URL", frozenset()),
    "wikipedia": (engine_wikipedia, None, frozenset({"auto"})),
    "stackexchange": (engine_stack_exchange, None, frozenset({"auto"})),
    "github": (engine_github, None, frozenset({"auto"})),
    "bingnews": (engine_bing_news, None, frozenset({"auto"})),
    "semanticscholar": (engine_semantic_scholar, "S2_API_KEY", frozenset({"auto", "optional_key"})),
    "gitee": (engine_gitee, "GITEE_TOKEN", frozenset({"auto"})),
    "hn": (engine_hn, None, frozenset({"auto"})),
    "juejin": (engine_juejin, None, frozenset({"auto"})),
    "arxiv": (engine_arxiv, None, frozenset({"auto"})),
    "mwmbl": (engine_mwmbl, None, frozenset()),
    "csdn": (engine_csdn, None, frozenset({"auto"})),
    "openalex": (engine_openalex, None, frozenset({"auto"})),
    "crossref": (engine_crossref, None, frozenset({"auto"})),
    "pubmed": (engine_pubmed, None, frozenset({"auto"})),
    "googlecse": (engine_google_cse, "GOOGLE_API_KEY", frozenset()),
    "huggingface": (engine_huggingface, None, frozenset({"auto"})),
    "baidu": (engine_baidu, None, frozenset()),
    "sogouweb": (engine_sogou_web, None, frozenset()),
    "so360": (engine_so360, None, frozenset()),
    "sogouweixin": (engine_sogou_weixin, None, frozenset({"backup"})),
    "anysearch": (engine_anysearch, "ANYSEARCH_API_KEY", frozenset({"optional_key", "backup"})),
    "keenable": (engine_keenable, "KEENABLE_API_KEY", frozenset({"optional_key", "backup"})),
}

BACKUP_ENGINES_ENV = "EASY_WEB_SEARCH_ENGINES"

# Key-gated providers live in their own module to keep this file navigable.
for _name, _entry in build_extra_engines(http_text, parse_json).items():
    ENGINES.setdefault(_name, (_entry["fn"], _entry["key"], frozenset()))


def _extract_intl_query(query: str) -> str:
    """Extract the longest ASCII keyword run."""
    runs = re.findall(r'[A-Za-z][A-Za-z0-9+#./\/_ -]{2,}', query)
    cleaned = [r.strip() for r in runs if len(r.strip()) >= 3]
    return max(cleaned, key=len) if cleaned else query


def route_auto(query: str, env: dict | None = None) -> dict:
    """Query-intent routing: auto tier engines join on strong signals only."""
    add = []
    q = query.lower()
    if re.search(r"github|gitee|开源仓库|源码|repo\b|open[- ]?source", q):
        add.append("github")
        # Gitee anonymous search is empty (engine-notes v1.9) — only route when tokened.
        if env and env.get("GITEE_TOKEN"):
            add.append("gitee")
    if re.search(r"stackoverflow|stack\s?exchange|报错|exception|traceback|怎么解决|how to (fix|debug)", q):
        add.append("stackexchange")
    if re.search(r"论文|文献|arxiv|学术|research paper|preprint", q):
        add.extend(["arxiv", "openalex", "crossref", "pubmed", "semanticscholar"])
    if re.search(r"新闻|快讯|资讯|breaking news|latest news", q):
        add.append("bingnews")
    if re.search(r"什么是|是什么|啥是|是啥|什么意思|百科|维基百科|wikipedia|是谁|who is|history of", q):
        add.append("wikipedia")
    if re.search(r"hacker\s?news|show\s?hn|tech news|科技新闻", q):
        add.append("hn")
    # Tech-vertical engines: only useful for technical questions, and actively
    # harmful elsewhere (a medical query returned "React 面试题" from juejin).
    if re.search(r"编程|代码|程序员|开发者|教程|报错|调试|\bbug\b|算法|面试|框架|源码|数据库|\bsql\b|docker|k8s|kubernetes|linux|\bgit\b|\bapi\b|\bsdk\b|javascript|typescript|python|\bjava\b|golang|\brust\b|\breact\b|\bvue\b|node\.?js|webpack|vite|\bcss\b|\bhtml\b|掘金|juejin|csdn|机器学习|深度学习|大模型|\bllm\b|模型部署|神经网络", q):
        add.extend(["juejin", "csdn"])
    if re.search(r"huggingface|数据集|dataset|模型权重|model weights|safetensors|embedding 模型", q):
        add.append("huggingface")
    # Repo Q&A: only when the query actually names an owner/repo.
    if re.search(r"github|仓库|源码|实现|架构|internals|architecture|codebase", q) \
            and re.search(r"\b[\w.-]+/[\w.-]+\b", q):
        add.append("deepwiki")
    # Library docs: a docs-ish ask about a library/API.
    if re.search(r"文档|用法|怎么用|\bapi\b|\bdocs?\b|usage|教程", q) \
            and re.search(r"python|javascript|typescript|rust|\bgo\b|\bjava\b|react|vue|node|tokio|npm|pip|docker|sql|redis|kafka|fastapi|django|flask|express|next\.?js", q):
        add.append("context7")
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
            # Prefer the already-clean URL for display/citation when one arrives.
            if item.get("url") != key and r["url"] == key:
                item["url"] = r["url"]
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
            "SEARXNG_BASE_URL", "GOOGLE_API_KEY", "GOOGLE_CX", "S2_API_KEY",
            "GITEE_TOKEN")
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
        routed = route_auto(ctx["query"], env)
        for n in routed["engines"]:
            if n not in [e[0] for e in engines] and n in ENGINES:
                engines.append((n, ENGINES[n][0]))
        if routed["engines"]:
            # Only vertical engines opt into the extracted ASCII run; rewriting
            # ctx["query"] would drop the Chinese half of a mixed query for
            # every general-web engine.
            ctx["intl_query"] = routed["intl_query"]
    elif args.no_cooldown:
        pass  # --no-cooldown implies skip routing too (clean state)
    if not args.engine and in_cooldown and len(in_cooldown) < len(engines):
        for n in in_cooldown:
            cooldown_skipped.append({"name": n, "ok": False, "count": 0, "ms": 0,
                                     "error": f"skipped (cooldown: {state[n].get('reason', 'recent failure')})"})
        engines = [(n, fn) for n, fn in engines if n not in in_cooldown]

    statuses = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(engines)) as ex:
        futures = {}
        for name, fn in engines:
            # Record t0 at submit time — fut.result() only returns after the
            # work is done, so timing around it always reports ~0ms.
            futures[ex.submit(fn, ctx)] = (name, time.time())
        for fut in concurrent.futures.as_completed(futures):
            name, t0 = futures[fut]
            try:
                results = fut.result()
                statuses.append({"name": name, "ok": True, "count": len(results),
                                 "ms": int((time.time() - t0) * 1000), "results": results, "error": ""})
            except Exception as e:
                statuses.append({"name": name, "ok": False, "count": 0,
                                 "ms": int((time.time() - t0) * 1000), "results": [], "error": str(e)})

    ok_results = [(s["name"], s["results"]) for s in statuses if s["ok"]]

    # Persist cooldown bookkeeping: successes clear, failures arm a cooldown, and
    # an engine that keeps answering with zero hits is benched too — a dead
    # upstream (searxng whose own backends are rate-limited) should stop taking a
    # slot on every run instead of costing seconds for nothing.
    COOLDOWN_MS_EMPTY = 5 * 60 * 1000
    EMPTY_STREAK_LIMIT = 2
    dirty = False
    for s in statuses:
        if s["ok"] and s["count"] > 0:
            if s["name"] in state:
                del state[s["name"]]
                dirty = True
        elif s["ok"]:
            zeros = int(state.get(s["name"], {}).get("zeros", 0)) + 1
            if zeros >= EMPTY_STREAK_LIMIT:
                state[s["name"]] = {"until": now_ms + COOLDOWN_MS_EMPTY,
                                    "reason": f"no results in {zeros} consecutive queries",
                                    "zeros": zeros}
                dirty = True
            elif state.get(s["name"], {}).get("zeros") != zeros:
                state[s["name"]] = {**state.get(s["name"], {}), "zeros": zeros}
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

    # "ok but zero hits" is not a failure. Label it so a caller never
    # mistakes an idle engine for a broken one.
    for s in statuses:
        if s["ok"] and s["count"] == 0:
            s["note"] = "reachable, no hits for this query"

    # --days is not supported by every engine — say so instead of silently
    # ignoring it.
    if ctx["days"] > 0:
        for s in statuses:
            if s["name"] == "bing" and s["ok"]:
                s["note"] = "days ignored by bing"

    all_engines = cooldown_skipped + statuses
    ranked = fuse(ok_results)
    # --site / --exclude-site are enforced HERE, not only by handing the site:
    # operator to engines: vertical engines ignore it outright and bing does not
    # always honour it, so "restrict to domain" was advisory.
    if args.site or args.exclude_site:
        def _host(u):
            try:
                return (urllib.parse.urlsplit(u).hostname or "").removeprefix("www.").lower()
            except ValueError:
                return ""

        def _norm(d):
            d = d.lower().removeprefix("http://").removeprefix("https://").removeprefix("www.")
            return d.split("/")[0]

        sites = [d for d in (_norm(s) for s in args.site) if d]
        excluded = [d for d in (_norm(s) for s in args.exclude_site) if d]

        def _in(h, d):
            return h == d or h.endswith("." + d)

        ranked = [r for r in ranked
                  if (not sites or any(_in(_host(r["url"]), d) for d in sites))
                  and not any(_in(_host(r["url"]), d) for d in excluded)]
    fused = [r for r in ranked if not _is_off_topic_scraped_hit(r, ctx["query"])][: args.num]

    if args.json:
        print(json.dumps({
            "query": ctx["query"],
            "engines": [{k: s[k] for k in ("name", "ok", "count", "ms", "error", "note") if k in s} for s in all_engines],
            "results": [{"rank": i + 1, "title": r["title"], "url": r["url"],
                         "snippet": r["snippet"], "score": round(r["score"], 4),
                         "engines": r["engines"]}
                        for i, r in enumerate(fused)],
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
