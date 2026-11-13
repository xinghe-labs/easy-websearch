---
name: easy-websearch
description: |
  Multi-engine web search with reliability-first failover and Chinese source
  optimization. Zero-config: works without any API key (DuckDuckGo + Bing);
  automatically upgrades when any of BRAVE_API_KEY, TAVILY_API_KEY,
  SERPER_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, BOCHA_API_KEY,
  METASO_API_KEY, LINKUP_API_KEY, or OLLAMA_API_KEY is set; two more keyless
  engines (AnySearch, Keenable) are available as opt-in backups via --engine
  or EASY_WEB_SEARCH_ENGINES. Fuses results across engines with Reciprocal
  Rank Fusion, decodes tracking redirects, cools down failing engines, and
  never fails silently — each engine reports its own status. Includes a
  URL-to-Markdown page reader (direct → Firecrawl → reader fallback) and a
  doctor self-check command.
  Use whenever the user wants to search the web, look something up, find
  current information, research a topic, check the latest news, or read a
  webpage's content: e.g. "search for", "look up", "find articles about",
  "what's the latest on", "查一下", "搜一下", "帮我查", "最新消息".
  Runs offline via bundled zero-dependency scripts (Node or Python).
---

# easy-websearch

Multi-engine web search + page reader as a self-contained script tool.
Free without API keys; better with them.

This file is an **execution contract for the agent**: you run the scripts on
the user's behalf during a conversation and turn their output into an answer.
Three ground rules:

1. **You are the operator.** When the user says "look up X", run the script
   yourself. Never tell them to type commands.
2. **You are the translator.** stdout/stderr is raw material. Never paste it
   at the user.
3. **You are the record keeper.** Cite only URLs that actually appeared in
   tool output. Report failures honestly — no smoothing over.

## When to use

- Any request needing current web information: news, facts, docs, prices, research
- Chinese-language queries (region-tuned DuckDuckGo `cn-zh` + Bing `zh-CN` + baidu + Google via Serper)
- Reading a specific URL's content as clean Markdown
- Situations where built-in search is unavailable, rate-limited, or blocked
- Broad research questions ("research X", "compare A vs B") — use the
  `research` evidence collector below

Choosing between this skill and a built-in web tool:

| Situation | Choice |
|---|---|
| Needs Chinese sources (CSDN/知乎/juejin/WeChat) | **this skill**, `--lang zh` |
| Needs cross-source verification / "which engines agree" | **this skill** (RRF fusion + per-hit engine attribution) |
| Built-in search failed, was rate-limited, or returned empty | **this skill** |
| Read a specific URL as clean Markdown | **this skill**'s `fetch` |
| Diagnose "why do searches return nothing" | **this skill**'s `doctor` |
| One-line fact, built-in tool works fine | built-in tool; don't add overhead |
| Login-gated, paywalled, or interactive pages | neither; tell the user it's not retrievable |

If the user explicitly names easy-websearch, always use it.

## Setup

Resolve the script directory first — do not guess a path:

```bash
SKILL_DIR=$(for d in ./easy-websearch ../easy-websearch \
    "$HOME/.agents/skills/easy-websearch" \
    "$HOME/.claude/skills/easy-websearch"; do
  [ -f "$d/scripts/search.mjs" ] && { echo "$d"; break; }
done)
[ -n "$SKILL_DIR" ] || echo SKILL_NOT_FOUND
```

Then pick a runtime (both scripts are zero-dependency twins — prefer `node`,
fall back to `python3`):

```bash
command -v node && echo NODE_OK || command -v python3 && echo PY_OK
```

`SKILL_NOT_FOUND`, or no runtime at all → **stop and tell the user**. Never
invent search results.

Optional upgrades (all optional; detected automatically, never required):

```bash
export BRAVE_API_KEY=...      # https://brave.com/search/api/  (2k free/mo, card required)
export TAVILY_API_KEY=...     # https://tavily.com             (1k free/mo)
export SERPER_API_KEY=...     # https://serper.dev             (2,500 one-time, Google results)
export EXA_API_KEY=...        # https://exa.ai                 ($10/mo credits, semantic search)
export FIRECRAWL_API_KEY=...  # https://firecrawl.dev          (1k/mo, search + better fetch)
export BOCHA_API_KEY=...      # https://open.bochaai.com       (Chinese web search, paid)
export METASO_API_KEY=...     # https://metaso.cn/search-api   (Chinese AI search)
export LINKUP_API_KEY=...     # https://linkup.so              ($20/mo credit, sourced answers)
export OLLAMA_API_KEY=...     # https://ollama.com             (web search API)
export GOOGLE_API_KEY=...     # https://console.cloud.google.com (CSE, 100/day)
export GOOGLE_CX=...          # https://programmablesearchengine.google.com (search engine id)
export GITEE_TOKEN=...        # https://gitee.com/profile/personal_access_tokens (CN code search)
export SEARXNG_BASE_URL=...   # self-hosted SearXNG (enable JSON in settings.yml)
export ANYSEARCH_API_KEY=...  # optional; anonymous works with lower limits
export KEENABLE_API_KEY=...   # optional; anonymous works with lower limits
export S2_API_KEY=...         # optional; https://www.semanticscholar.org/product/api (lifts 429s)
```

Keyless backup engines (anysearch, keenable, sogouweixin) are OFF by default.
opt in per-run with `--engine sogouweixin` (WeChat articles — great for
Chinese tech content) or for the session with
`export EASY_WEB_SEARCH_ENGINES=sogouweixin`.

Chinese queries get baidu in the default pool (no key) — plus bocha/metaso
when configured.

### Provider catalogue (70 engines)

Beyond the ones above, 31 more providers are wired and dormant until their key
exists. `doctor` lists each one as `SKIP … get it: <url>`, and `--engine <name>`
without the key answers `"<ENV> not set"` instead of failing obscurely.

| Group | Engines (env var) |
|---|---|
| Google SERP resellers | `serpapi` (SERPAPI_API_KEY), `serpbase` (SERPBASE_API_KEY), `searchapi` (SEARCHAPI_API_KEY), `serply` (SERPLY_API_KEY), `xcrawl` (XCRAWL_API_KEY) |
| Modern search APIs | `kagi` (KAGI_API_KEY), `serpdive` (SERPDIVE_API_KEY), `valyu` (VALYU_API_KEY), `you` (YOU_API_KEY), `jina` (JINA_API_KEY), `search1api` (SEARCH1API_API_KEY), `searchinfinity` (SEARCHINFINITY_API_KEY), `querit` (QUERIT_API_KEY), `sofya` (SOFYA_API_KEY), `outcrawl` (OUTCRAWL_API_KEY), `ceramic` (CERAMIC_API_KEY), `tinyfish` (TINYFISH_API_KEY), `tabstack` (TABSTACK_API_KEY), `parallel` (PARALLEL_API_KEY), `deepseek` (DEEPSEEK_API_KEY), `kimi` (KIMI_API_KEY), `perplexity` (PERPLEXITY_API_KEY) |
| LLM-native search | `openai` (OPENAI_API_KEY), `xai` (XAI_API_KEY), `gemini` (GEMINI_API_KEY), `mistral` (MISTRAL_API_KEY) |
| MCP-shaped | `baizhi` (BAIZHI_API_KEY), `zai` (ZAI_API_KEY) |
| MCP-shaped, **keyless** | `deepwiki` (GitHub repo Q&A), `context7` (library docs) — auto tier, no key |
| Self-hosted / account | `ninerouter` (NINEROUTER_BASE_URL), `cloudflare` (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID), `brightdata` (BRIGHTDATA_API_KEY + BRIGHTDATA_ZONE) |

None of these join the default pool — they run only when `--engine` names them
or `EASY_WEB_SEARCH_ENGINES` opts them in. Their request shapes come from the
same provider implementations the built-in web_search uses, but **they are
unverified against the live APIs** (no keys were available to test), so treat
the first run of a newly keyed engine as a smoke test.

Show any `*_API_KEY` as first/last 4 chars only (e.g. `sk-…a1b2`); never echo
a key into a command line, log, or file; never spend paid quota just to
"verify a key works".

If the user's environment has an HTTP(S)_PROXY set, both runtimes honor it
automatically (Node via a built-in CONNECT tunnel; Python via urllib).

## Search

For non-English queries pass `--lang zh` (or `en`) — without it the results
follow the network location rather than the query language.

```bash
node scripts/search.mjs "query" [options]
python3 scripts/search.py "query" [options]
```

Options:

| Flag | Meaning |
|---|---|
| `-n 10` | max results (default 10) |
| `--days 7` | time window (DDG: d/w/m granularity; Exa: exact date) |
| `--site example.com` | restrict to domain (repeatable) |
| `--exclude-site foo.com` | exclude domain (repeatable) |
| `--lang zh` | language/region boost: `zh` or `en` |
| `--engine ddg,bing` | restrict/enable engines (backups `anysearch`,`keenable` need this or `EASY_WEB_SEARCH_ENGINES`) |
| `--timeout 8` | per-**attempt** timeout in seconds; engines that rotate endpoint variants (bing, baidu, so360) can take a multiple of this before they give up |
| `--direct` | bypass the proxy for every engine (`EASY_WEB_SEARCH_DIRECT=1` does the same for the whole session). Use it when doctor reports several scrape engines failing behind a proxy — see Troubleshooting below |
| `--no-cooldown` | disable the failure cooldown (by default, engines that just failed are skipped for 10 min on default runs) |
| `--json` | machine-readable output (use this for further processing) |

Prefer `--json` and parse the output; it includes per-engine status
(`{name, ok, count, ms, error}`) so you can tell the user exactly what
happened. Text mode prints results with `[engines]` attribution per hit.

The **default pool is general web only**, queried concurrently on every call:
`ddg bing baidu sogouweb so360 examcp parallelmcp degoog searxng mwmbl`.
`examcp` and `parallelmcp` are keyless MCP endpoints that return real page
excerpts rather than a scraped SERP — in practice they carry the answer, and
the scraped engines fill in. Vertical engines join only on matching query
intent (see "Interpreting results").

Two speeds, pick deliberately:

| Need | Call | Typical wall time |
|---|---|---|
| quick single fact, one URL to read | `--engine ddg,bing` | ~1-2s |
| Chinese sources, cross-engine confirmation, research | full default pool | ~3-4s |

`--engine` **replaces** the default set (it does not add to it), so name every
engine you want. Backups (`anysearch`, `keenable`, `sogouweixin`) only run
when named or enabled via `EASY_WEB_SEARCH_ENGINES`.

Exit codes — branch on these, don't parse prose:

| Command | Code | Meaning |
|---|---|---|
| search | 0 | normal (with `--json` this is 0 even for 0 results — check `results.length`) |
| search | 1 | text mode: no results from any engine |
| search | 2 | bad usage / no usable engine |
| fetch | 0 | `--json` always exits 0; read the `ok` field |
| fetch | 1 | text mode fetch failed; 2 = missing URL |
| doctor | 0 / 1 / 2 | all OK or WARN / any FAIL / nothing testable |

## Presenting results

Do not dump stdout or JSON at the user. Answer in this shape:

```markdown
<one-sentence answer>

- Point 1 — [source title](url) (confirmed by: ddg+bing)
- Point 2 — [source title](url) (single source)
- Point 3 — [source title](url)
```

- **Answer first**, at most 5 bullets; details after, on request.
- Every load-bearing claim gets an **inline link** from this run's output.
- Label evidence strength: `confirmed` (≥2 engines, or ≥2 independent
  domains) / `single source` / `conflicting` (say so explicitly — never pick
  one side and hide the other).
- A URL returned by several engines in `engines` is stronger — prefer it.
- **Do not append engine status to the answer.** No "engine note" line, no
  list of which engines failed, no footer. Engine status lives in the `--json`
  `engines[]` array and is for *your* diagnosis, not for the user's answer.
  Surface it only when the user asks, or when the failures are why you cannot
  answer at all (then say it in the answer body, not as a trailing note).
- "Latest / today" questions → pass `--days` and state the window.
- Very long content → write a file and give the path; don't pour 20k
  characters into the chat.

## Interpreting results

- `engines` per hit lists which engines returned that URL — hits found by
  2+ engines rank higher (Reciprocal Rank Fusion) and are usually stronger sources.
- `ok: true` with `count: 0` means **the engine answered but had nothing for
  this query** (it carries `note: "reachable, no hits for this query"`). That
  is not a failure — don't report it as one, and don't drop the engine from
  your mental model of what was searched.
- The default pool is **general web only** (`ddg bing baidu sogouweb so360
  examcp parallelmcp degoog searxng mwmbl`). Vertical engines — `juejin`,
  `csdn`, `wikipedia`, `hn`, `arxiv`, `openalex`, `crossref`, `pubmed`,
  `semanticscholar`, `github`, `gitee`, `stackexchange`, `huggingface`,
  `bingnews` — join only when the query shows the matching intent (tech terms,
  academic terms, 什么是/百科, repo/源码, ...). That is why a medical question
  no longer returns React interview posts from a tech blog. `--engine` always
  overrides the routing.
- `--site` / `--exclude-site` are enforced on the fused set, so the filter
  holds for every engine even though vertical engines ignore the `site:`
  operator internally.
- A failed engine (e.g. `ddg: FAILED (HTTP 202)`) is normal and non-fatal:
  fusion continues with the rest. Do not retry the whole search because one
  engine failed.
- All engines failed → report the errors; suggest setting an API key.
- Engines marked `skipped (cooldown: ...)` failed recently; the cooldown
  avoids re-burning requests on them (state:
  `$XDG_CACHE_HOME/easy-websearch/cooldowns.json`). Reset with
  `node scripts/doctor.mjs --clear-cooldown`; override with `--engine <name>`
  or `--no-cooldown` when the user asks to retry. An engine that answers with
  **zero hits twice in a row** is benched for 5 minutes too — a dead upstream
  should not keep costing a slot on every run.
- Hits from scraped SERP engines (`ddg bing baidu sogouweb so360`) are dropped
  when they are demonstrably about something else: Korean/Japanese title for a
  Chinese query, a bare latin site name, or a Chinese title sharing no 2-char
  run with the query. Content engines (`examcp`/`parallelmcp`/`degoog`) are
  never filtered this way. Validated on a hand-checked corpus: 8 junk dropped,
  0 legitimate hits lost.
- Engines OK but 0 results → narrow / rephrase / add `--site`; **at most 2
  more attempts**, then say plainly that nothing was found.
- Two consecutive anomalies → run `doctor` once and report which engine is
  down, which key is missing, whether the proxy is detected. Don't keep
  re-rolling keywords.
- **Wall clock**: a normal call is 2-4s. If one `search` call runs past ~15s,
  do not retry the same query — switch to `--engine ddg,bing` for a fast
  answer, or tell the user the network is slow and give them what you have.
  A single slow engine should not cost the user three identical attempts.
- **Proxy blocking the scrape engines** (doctor: several of `ddg baidu
  sogouweb so360` failing while a proxy is active): retry once with
  `--direct` (or `EASY_WEB_SEARCH_DIRECT=1`) before concluding the network is
  at fault. Anti-bot layers often reject datacenter proxy exits but accept
  the direct connection. `--direct` applies to `search`, `research` and
  `doctor`; `fetch` always tries direct first and only proxies when the
  environment says so.
- `doctor` prints four statuses: `OK`, `SKIP` (key not configured), `WARN`
  (transient: anti-bot, rate limit, timeout, unparsable response) and `FAIL`
  (real problem). **`WARN` is normal and does not change the exit code** —
  public engines block datacenter IPs constantly. Never report WARN rows as
  "the search environment is broken"; mention them only if they explain a
  thin result set.
- `[not in default set]` in a doctor row means the engine is healthy but not
  part of the default pool — not a failure.

Forbidden: silent retries, describing a failure as "no relevant
information", filling gaps from memory.

## Research (multi-round evidence collector)

For broad research questions ("研究 X", "compare A vs B", "latest developments in X"):

```bash
node scripts/research.mjs "question" --json
python3 scripts/research.py "question" --json
```

Automatically decomposes the question into sub-queries, runs parallel searches
across the pool, fetches top pages, and outputs a structured evidence pack
(original text + sources + cross-hit annotations) for the agent to summarize.
Do NOT summarize in the script — the agent reads the evidence pack and writes
the answer with inline citations.

Options: `--queries "q1,q2,q3"` (agent-provided sub-queries, best quality),
`--depth 2` (pages per sub-query), `--max-searches 8`, `--max-fetches 12`.

**research vs. hand-rolled sub-queries** — pick one, don't do both:

| Situation | Choice |
|---|---|
| Question is broad but mechanical ("compare A vs B", "state of X") and you can name 3-6 angles yourself | `research` with `--queries` (you control the angles, it handles fan-out and fetching) |
| You need to see intermediate results to decide the next query (iterative narrowing) | plain `search` loop |
| One specific claim to verify against a specific page | `search --engine ddg,bing` + `fetch` |
| Chinese-only sources | `search --lang zh`, not `research` (its sub-queries drift to English) |

**Reading the evidence pack** (it can be large — never read it whole into a
first-pass answer):

```jsonc
{
  "sub_queries": ["..."],            // what was actually asked
  "evidence": [                       // per sub-query
    { "subQuery": "...",
      "engines_used": ["ddg", "bing"],
      "results": [ { "title", "url", "snippet", "engines",
                     "fetched": true, "content_excerpt": "..." },
                   { "title", "url", "snippet", "engines",
                     "fetch_error": "HTTP 403" } ] }
  ],
  "cross_hits": [ { "url", "engines", "count" } ],  // >=2 engines agree
  "coverage": { "bing": 4, "ddg": 3 },              // per-engine hit counts
  "budget_used": { "searches": 6, "fetches": 9, "fetch_failures": 2 }
}
```

Read order: `cross_hits` first (that is your confidence ranking) → then only
the `content_excerpt` fields you actually need → cite `url`. `coverage` is
for your own judgement of how thin the evidence is — like engine status, it
does not go into the answer.

A result carrying `fetch_error` could **not** be read — you have its title and
snippet only. Never imply you read such a page, and say so if the answer
hinges on it (`fetch_failures` in `budget_used` is the same fact aggregated).

Budget: one research task stays at **≤ 8 searches and ≤ 12 fetches** — the
`research` defaults already match. `fetch` starts at `--max-chars 4000` and
goes to 12000-20000 only when detail is genuinely needed; never leave it
unbounded. **Stop at saturation**: once sub-questions return the same URL
set, more queries add noise, not information.

## Health check (doctor)

When search results look odd or the user asks what engines are configured:

```bash
node scripts/doctor.mjs            # table: status, latency, config gaps per engine
python3 scripts/doctor.py --json   # machine-readable
```

Runs one tiny real search per engine (concurrently). Four statuses:
`OK`; `SKIP` (key not configured); `WARN` (transient — anti-bot, rate limit,
timeout, unparsable response); `FAIL` (real problem, e.g. misconfiguration).

Exit code: **0 all OK or WARN**, 1 any FAIL, 2 nothing testable. Transient
warnings are expected on public engines and must not be reported to the user
as a broken install. `--strict` promotes every failure to FAIL — use it in CI
or when the user explicitly asks "is everything really working?".

## Fetch page content

```bash
node scripts/fetch.mjs "https://example.com/article" [--json] [--max-chars 20000]
python3 scripts/fetch.py "https://example.com/article" [--json]
```

Extracts readable content as Markdown (title + meta description + body).
Fallback chain: direct fetch → **exa MCP reader** (keyless) → **parallel MCP
reader** (keyless) → Firecrawl scrape (when `FIRECRAWL_API_KEY` is set) →
r.jina.ai reader. `via` in the JSON output tells you which path succeeded —
in practice the two keyless MCP readers rescue pages the direct fetch cannot
read (JS-heavy or anti-bot pages come back with full text).

Latency is **not** uniform: a direct fetch is ~1s, but when it falls through
to the `r.jina.ai` reader the same call can take 10s+. That is the fallback
working, not a hang — do not call `fetch` twice for the same URL, and do not
report it as a failure when `ok` is true.

## Research workflow (multi-question tasks)

For broad research requests ("research X", "compare options", "latest developments"):

1. Decompose the topic into 3-6 distinct sub-queries (different angles, both
   English and Chinese when relevant) rather than one broad query.
2. Run `search` per sub-query with `--json`, `--lang` matching the query language.
3. Fetch the top 2-3 promising URLs per sub-query with `fetch` before citing.
4. Cross-check facts that appear in only one source; prefer hits returned by
   multiple engines.
5. Produce an answer with inline source links; state the per-engine coverage
   (e.g. "confirmed by ddg+bing") for load-bearing claims.

## Install, update, MCP, CLI

One folder, three shapes. When the user asks how to install, upgrade, wire it
into a client, or run it from a terminal, name these accurately — do not invent
commands.

**1) Agent skill** (this file — the shape you are using right now)

```bash
npx skills add xinghe-labs/easy-websearch          # or update in place
node scripts/setup.mjs            # detect ~/.claude/skills, ~/.agents/skills, project dirs → install → doctor
node scripts/setup.mjs --list     # dry run
node scripts/setup.mjs --dir <p>  # explicit target (repeatable)
```

`setup.mjs` runs doctor from the installed copy, so a broken install fails
loudly instead of silently.

**2) MCP server** — `server.mjs`, JSON-RPC 2.0 over stdio, four tools:
`web_search`, `read_page`, `deep_research`, `engine_status`.

```json
{"mcpServers":{"easy-websearch":{"command":"node","args":["<path>/server.mjs"]}}}
```

It answers one-shot piped requests too, which is the fastest way to check a
client-side problem:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"web_search","arguments":{"query":"webgpu","numResults":3}}}' | node server.mjs
```

**3) CLI** — `bin/cli.mjs`, installed as `easy-websearch`:

```bash
easy-websearch search "query" --lang zh -n 5
easy-websearch fetch "https://example.com/article"
easy-websearch research "question" --json
easy-websearch doctor
easy-websearch setup --list
easy-websearch mcp-serve
```

All three share the same engines, filters and cooldown state — one install,
same behaviour whichever entry point is used.

## Anti-patterns

- Don't invent results — only cite URLs that actually appeared in tool output.
- Don't paste raw JSON or CLI formatting at the user.
- Don't run more than ~8 searches for one question; narrow the query instead.
- Don't paste fetched page text wholesale into the conversation.
- Don't pipe secrets into these scripts; they only need the optional env keys.
- Don't declare "search is unavailable" when only some engines failed.
