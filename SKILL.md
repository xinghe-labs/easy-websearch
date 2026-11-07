---
name: easy-websearch
description: |
  Multi-engine web search with reliability-first failover and Chinese source
  optimization. Zero-config: works without any API key (DuckDuckGo + Bing);
  automatically upgrades when BRAVE_API_KEY, TAVILY_API_KEY, SERPER_API_KEY,
  or EXA_API_KEY is set; two more keyless engines (AnySearch, Keenable) are
  available as opt-in backups via --engine or EASY_WEB_SEARCH_ENGINES. Fuses results across engines with Reciprocal Rank
  Fusion, decodes tracking redirects, and never fails silently — each engine
  reports its own status. Includes a URL-to-Markdown page reader.
  Use whenever the user wants to search the web, look something up, find
  current information, research a topic, check the latest news, or read a
  webpage's content: e.g. "search for", "look up", "find articles about",
  "what's the latest on", "查一下", "搜一下", "帮我查", "最新消息".
  Runs offline via bundled zero-dependency scripts (Node or Python).
---

# easy-websearch

Multi-engine web search + page reader as a self-contained script tool.
Free without API keys; better with them.

## When to use

- Any request needing current web information: news, facts, docs, prices, research
- Chinese-language queries (region-tuned DuckDuckGo `cn-zh` + Bing `zh-CN` + Google via Serper)
- Reading a specific URL's content as clean Markdown
- Situations where built-in search is unavailable, rate-limited, or blocked

## Setup

Locate this skill's directory, then pick a runtime (both scripts are
zero-dependency twins — prefer `node`, fall back to `python3`):

```bash
command -v node && echo NODE_OK || command -v python3 && echo PY_OK
```

Optional upgrades (all optional; detected automatically, never required):

```bash
export BRAVE_API_KEY=...    # https://brave.com/search/api/  (2k free/mo)
export TAVILY_API_KEY=...   # https://tavily.com             (1k free/mo)
export SERPER_API_KEY=...   # https://serper.dev             (Google results)
export EXA_API_KEY=...      # https://exa.ai                 (semantic search)
export ANYSEARCH_API_KEY=...   # optional; anonymous works with lower limits
export KEENABLE_API_KEY=...    # optional; anonymous works with lower limits

Keyless backup engines (anysearch, keenable) are OFF by default — their
anonymous quotas are low. Opt in per-run with `--engine anysearch,keenable`
or for the whole session with `export EASY_WEB_SEARCH_ENGINES=anysearch,keenable`.
Use them when DDG/Bing are both degraded, or for extra coverage on hard queries.
```

If the user's environment has an HTTP(S)_PROXY set, both runtimes honor it
automatically (Node via a built-in CONNECT tunnel; Python via urllib).

## Search

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
| `--timeout 8` | per-engine timeout in seconds |
| `--json` | machine-readable output (use this for further processing) |

Prefer `--json` and parse the output; it includes per-engine status
(`{name, ok, count, ms, error}`) so you can tell the user exactly what
happened. Text mode prints results with `[engines]` attribution per hit.

Interpreting results:

- `engines` per hit lists which engines returned that URL — hits found by
  2+ engines rank higher (Reciprocal Rank Fusion) and are usually stronger sources.
- A failed engine (e.g. `ddg: FAILED (HTTP 202)`) is normal and non-fatal:
  fusion continues with the rest. Do not retry the whole search because one
  engine failed.
- All engines failed → report the errors; suggest setting an API key.

## Fetch page content

```bash
node scripts/fetch.mjs "https://example.com/article" [--json] [--max-chars 20000]
python3 scripts/fetch.py "https://example.com/article" [--json]
```

Extracts readable content as Markdown (title + meta description + body).
If the site blocks direct fetching (403/429/anti-bot), it automatically
falls back to the r.jina.ai reader. `via` in the JSON output tells you
which path succeeded.

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

## Anti-patterns

- Don't invent results — only cite URLs that actually appeared in tool output.
- Don't run more than ~8 searches for one question; narrow the query instead.
- Don't pipe secrets into these scripts; they only need the optional env keys.
