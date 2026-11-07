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
