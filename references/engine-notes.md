# Engine Feasibility Notes (v1 baseline)

Verified 2026-11-07 from a mainland-China network with a local proxy
(`HTTPS_PROXY=http://127.0.0.1:10808`). Probe scripts live in `sandbox/`
(gitignored).

## Baseline engines (no API key)

| Engine | Method | Result | Notes |
|---|---|---|---|
| DuckDuckGo | `POST https://html.duckduckgo.com/html/` form-encoded | ✅ 11 results | `kl=cn-zh` region param works for Chinese queries. Result links are `/l/?uddg=<urlencoded>` redirects that must be decoded. Returns HTTP 202 anomaly pages on some GETs — POST is more reliable. |
| Bing | `GET https://www.bing.com/search?q=…&mkt=zh-CN` | ✅ 10 results | Reachable from mainland China **without proxy** — this is the fallback that guarantees results for users behind the GFW. Results in `<li class="b_algo">` blocks. |
| SearXNG public instances | `GET /search?q=…&format=json` | ❌ dropped | Public instances returned 429 / SSL resets. Too unstable for a baseline; may return as user-configurable extra (`SEARXNG_BASE_URL`). |

## Runtime proxy behavior (critical implementation constraint)

- **Node `fetch` (undici) ignores `HTTP(S)_PROXY` env vars.** A naive
  `fetch()` implementation will fail for all non-CN-reachable engines even
  when the user has a working system proxy.
  → The Node implementation MUST implement an HTTP CONNECT tunnel itself
  (zero-dep, `node:net` + `node:tls`) when `HTTPS_PROXY`/`https_proxy` is set.
- **Python `urllib.request` honors `*_proxy` env vars automatically.**
  → No extra work needed in the Python implementation.

## Optional-key backup engines (v1.1)

Probed 2026-11-07 (both anonymous, from a proxied CN network):

| Engine | Method | Result | Notes |
|---|---|---|---|
| AnySearch | `POST https://api.anysearch.com/v1/search` `{query, max_results}` | ✅ anonymous 200 | Envelope `{code:0, data:{results:[{title,url,snippet,content}]}}`. Key optional (`ANYSEARCH_API_KEY`). Low anonymous quota — backup only. |
| Keenable | `POST https://api.keenable.ai/v1/search/public` `{query, max_results, snippet_max_length}` | ✅ keyless 200 | **Requires `X-Keenable-Title` header** on the public endpoint (400 otherwise). Results `{title,url,snippet}`; drop `cards.keenable.ai` URLs (ephemeral). Keyed path: `/v1/search` + `X-API-Key`. |

Neither is in the default engine set (anonymous quotas are low). Opt in via
`--engine anysearch,keenable` or `EASY_WEB_SEARCH_ENGINES=anysearch,keenable`.

## Design consequences

1. Reliability-first ordering confirmed: with proxy → DDG + Bing; without
   proxy → DDG fails fast (seconds), Bing still returns results. Per-engine
   timeout + fail-open is mandatory.
2. Optional-key engines (Brave/Tavily/Serper/Exa) are all plain HTTPS JSON
   APIs, reachable from CN via the same proxy tunnel.
3. DDG HTML responses sometimes arrive as anomaly/challenge pages; parser
   must treat "0 results but 200 OK" as a soft failure, not success.

## Keyed engines added in v1.2

Schemas verified against live docs 2026-11-07; fake-key e2e shows clean
per-engine failures (HTTP 401 / wrapped error bodies) instead of crashes.

| Engine | Method | Request | Response results | Notes |
|---|---|---|---|---|
| Firecrawl | `POST api.firecrawl.dev/v1/search` | `{query, limit, scrapeOptions:{formats:["markdown"]}}` | `data[] {title,url,description,markdown?}` (array or `data.web[]`) | Bearer `FIRECRAWL_API_KEY`. `/v1/scrape` also powers the fetch fallback layer (direct → firecrawl → r.jina.ai). |
| Bocha 博查 | `POST api.bochaai.com/v1/web-search` | `{query, freshness, summary, count}` — freshness: noLimit/oneDay/oneWeek/oneMonth/oneYear (mapped from `--days`) | `data.webPages.value[] {name,url,snippet}` | Bearer `BOCHA_API_KEY`. **415 gotcha**: urllib's default form-urlencoded Content-Type beats `opener.addheaders` — fixed via a late `_HeaderInjector` handler. |
| Metaso 秘塔 | `POST metaso.cn/api/v1/search` | `{mode:"search", q, scope:"webpage", size:"10", includeSummary, conciseSnippet}` | envelope **not formally documented** — defensive walk for URL-bearing objects | Bearer `METASO_API_KEY`. **Wraps errors in HTTP 200**: `{"errCode":2005,"errMsg":"API密钥无效"}` (curl) and `{"code":5000,"message":"系统内部错误"}` (urllib) — both shapes checked. |
| Linkup | `POST api.linkup.so/v1/search` | `{q, depth:"standard", outputType:"searchResults"}` | `results[] {name,url,content}` | Bearer `LINKUP_API_KEY`. |
| Ollama | `POST ollama.com/api/web_search` | `{query}` | `results[] {title,url,content}` | Bearer `OLLAMA_API_KEY`. Free account key. |

Failure cooldown (v1.2): failed engines are recorded in
`$XDG_CACHE_HOME/easy-websearch/cooldowns.json` and skipped for 10 min on
default runs (never skip to zero; `--engine`/`--no-cooldown` bypass). This
stops a rate-limited engine from burning every subsequent request.

## No-key baseline expansion (v1.5)

Probed 2026-11-07 (proxied CN network + direct):

| Engine | Verdict | Evidence |
|---|---|---|
| Baidu | ✅ default pool | 200 OK, 7+ relevant `<h3><a>` results, no captcha; needs referer. `/link` wrappers resolved to real URLs (200-required, retry once — first hit often 403). Bot-junk guard armed. |
| Sogou Weixin | ✅ opt-in vertical | `weixin.sogou.com/weixin?type=2` stable x3, no captcha; 10 WeChat articles/query. `/link` needs SNUID cookie (shared jar) + JS-stub decode (`url += '…'` fragments). WeChat-articles-only. |
| Startpage | ❌ dropped | POST /sp/search → 302 to `/sp/captcha-block` (datacenter-IP block). |
| Mojeek | ❌ dropped | 403 Forbidden (proxy and direct). |
| Marginalia | ❌ dropped | API endpoint 404; HTML SERP yields ~2 external links/query — too weak. |

## SearXNG (self-hosted, v1.5)

`SEARXNG_BASE_URL` env activates the `searxng` engine (keyed-style: engine
joins automatically when the env var is set). Instance must enable JSON:
`search.formats: [html, json]` in settings.yml — otherwise the engine fails
with an explicit hint. Supports `--lang zh|en` via the `language` param.

## Cookie jar (v1.5)

Both runtimes keep a process-lifetime cookie jar (node: Map host→cookies,
injected into outgoing requests + stored from Set-Cookie; python: stdlib
CookieJar via HTTPCookieProcessor). Primary driver: Sogou /link requires
SNUID from the search response. Side benefit: more browser-like to anti-bot
layers everywhere.
