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

## Owner-requested engine expansion (v1.9, 2026-11-09)

Probed and added 4 engines (30 → 34); evidence below.

| Engine | Tier | Contract | Probe evidence |
|---|---|---|---|
| Google CSE | keyed (`GOOGLE_API_KEY` + `GOOGLE_CX`) | `GET www.googleapis.com/customsearch/v1?key&cx&q&num` → `items[]{title,link,snippet}`; `num` ≤ 10; `hl` for lang | Without a key: HTTP 400 `API key not valid` (clean JSON error shape, surfaced verbatim). Free 100/day per official docs. |
| Semantic Scholar | auto, `optional_key` (`S2_API_KEY`) | `GET api.semanticscholar.org/graph/v1/paper/search?query&limit&fields` → `data[]{title,url,year,venue,citationCount}` | Keyless probes returned **429 ×3** from this proxy exit — the anonymous pool is shared per-IP. Error message points at the free S2_API_KEY; cooldown absorbs. |
| Bing News | auto, keyless | `GET www.bing.com/news/search?q&format=rss&setmkt` → RSS items; `<link>` is an `apiclick.aspx` wrapper with the real target in the **`url=` param (last, raw)**; `News:Source` = publisher | 200, 9 items; `url=https://www.msn.cn/…` confirmed by decoding the full wrapper link. |
| Gitee | auto, keyed (`GITEE_TOKEN`) | `GET gitee.com/api/v5/search/repositories?q&per_page&access_token` → `[]{full_name,human_name,html_url,stargazers_count,description}` | **Anonymous search returns 200 with EMPTY arrays for every query** (vue / machine learning / rust) — effectively token-gated. Free personal access token unlocks it. Routed only when tokened. |

Also probed and rejected: **m.sogou.com** mobile variant — shares the desktop
`<h3><a>` markup but targets are relative `./id=<uuid>/keyword=…` wrappers
resolving to a 2.2 KB WAP interstitial with no meta-refresh / location / URL
pattern (JS-resolved client-side, unextractable zero-dep).

Free-tier verification for the existing keyed engines (2026-11-09, sources in
chat): Tavily 1,000/mo (no card) · Serper 2,500 one-time (no card) · Exa
$10/mo (no card) · Firecrawl 1,000/mo (no card) · Linkup $20/mo credit ·
Brave 2,000/mo (**card required**) · Bocha paid-only · Metaso API grant
(unpublished).

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

### Baidu/Sogou WAF fingerprint sensitivity (v1.5 addendum)

After heavy same-day testing, Baidu serves its security-verification page to
the python-urllib fingerprint while node requests keep passing from the same
IP (Connection: close + header casing differences are the likely triggers).
Both engines fail soft. Recommendation: CN engines (baidu/sogouweixin) are
most reliable on the node runtime; python users should expect intermittent
`no results parsed` / captcha failures — other engines cover, cooldown
absorbs. Also: these engines + searxng now bypass user proxies entirely
(`direct=True`), since datacenter proxy exits get blocked by CN anti-bot
layers immediately.

### Endpoint-variant rotation (v1.8 addendum)

Anti-bot blocks are per-host, so ddg/bing/baidu now rotate endpoint variants
before failing (and arming a cooldown). First success wins; the last error
is rethrown when all variants fail:

| Engine | Variants (in order) | Notes |
|---|---|---|
| ddg | `html.duckduckgo.com/html/` (POST) → `duckduckgo.com/html/` (POST) → `lite.duckduckgo.com/lite/` (GET) | lite is a separate table UI: `href="…" class='result-link'` anchors (single quotes, href precedes class) + `result-snippet` `<td>`s. Same `/l/?uddg=` redirect decode. |
| bing | `www.bing.com` → `cn.bing.com` → `global.bing.com` → `www.bing.com/search?…&format=rss` | Same `b_algo` markup on all regional hosts; junk pages are host-local, so junk on www rotates to cn. RSS is the last resort: structured XML from a different content pipeline — HTML bot-junk doesn't affect it (verified: 10 items/query, direct `<link>` URLs, no /ck/a wrappers). |
| baidu | `www.baidu.com/s?wd=` → `m.baidu.com/s?word=` | Mobile SERP uses `word` (not `wd`); both keep `direct=True`. Mobile WAF is reportedly looser on other fingerprints — on the v1.8 probe host it also serves the verification page, so the fallback is best-effort. |
| so360 | `www.so.com/s` → `m.so.com/s` | Desktop: `h3.res-title > a` + `res-desc`, `/link?m=` wrappers. Mobile: different card layout — URL is the closest preceding `m.so.com/jump?u=<enc>` wrapper (decode directly, no /link resolver needed), snippet in `p.g-main.summary`. WAF fingerprint asymmetry is inverted vs baidu: python-urllib passed mobile while node got captcha'd on the same day. |
| sogou | `www.sogou.com/web` only | **m.sogou.com probed 2026-11-08, ❌ dropped**: the mobile SERP shares the desktop `<h3><a>` markup but its targets are relative `./id=<uuid>/keyword=…` wrappers that resolve to a 2.2 KB WAP interstitial with no meta-refresh / location / URL pattern and no non-sogou links — the real target is JS-resolved client-side, unextractable zero-dep. Titles are parseable but URLs would dead-end; not worth a variant. |

Trade-off: a fully-blocked engine now burns up to 3-4 fetches before the
cooldown arms (engines run in parallel, so wall-clock impact is bounded).
Verified 2026-11-08: all variants return real SERPs from the probe host
(lite validated online after DDG anomaly cooldown; bing RSS and so360
mobile validated live — so360 mobile via the python runtime); rotation
paths are shared-shape loops exercised via live runs. Boundary: ddg's three
endpoints share one backend rate limiter — rotation defeats per-host
blocks, not IP-level ones.

### Wikipedia reachability boundary (v1.7 addendum)

en/zh.wikipedia.org reachability varies by environment: blocked from CN
direct (GFW), intermittently RST through some proxy chains (observed: node
ECONNRESET at 29s while py urllib crawled through at 29.5s and curl-SOCKS at
1s). The engine is correct — verified on reachable networks (py doctor OK,
CI runners OK). e2e pre-checks reachability and SKIPs when blocked.
