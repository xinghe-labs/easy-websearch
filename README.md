# easy-websearch

[English](README.md) | [简体中文](README.zh-CN.md)

[![engine-probe](https://github.com/xinghe-labs/easy-websearch/actions/workflows/engine-probe.yml/badge.svg)](https://github.com/xinghe-labs/easy-websearch/actions/workflows/engine-probe.yml)
[![Release](https://img.shields.io/github/v/release/xinghe-labs/easy-websearch)](https://github.com/xinghe-labs/easy-websearch/releases)
[![npm](https://img.shields.io/npm/v/easy-websearch)](https://www.npmjs.com/package/easy-websearch)
[![npm downloads](https://img.shields.io/npm/dw/easy-websearch)](https://www.npmjs.com/package/easy-websearch)
[![License: MIT](https://img.shields.io/badge/License-MIT-2F9E4F.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-%E2%89%A518-3C873A)
![Python](https://img.shields.io/badge/Python-%E2%89%A53.11-3776AB)

Multi-engine web search + page reader for AI coding agents — as a single
[Agent Skills](https://agentskills.io)-compatible skill folder.

**Zero-config**: works with no API key at all (DuckDuckGo + Bing baseline).
**Better with keys**: set `BRAVE_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY`,
`EXA_API_KEY`, `FIRECRAWL_API_KEY`, `BOCHA_API_KEY`, `METASO_API_KEY`,
`LINKUP_API_KEY`, or `OLLAMA_API_KEY` and those engines join the pool
automatically. Two more keyless engines (AnySearch, Keenable) are available
as opt-in backups (`EASY_WEB_SEARCH_ENGINES=anysearch,keenable`) for extra
coverage. Failing engines get a 10-minute cooldown so one bad engine never
burns the whole request.

```text
query ──► [ ddg ] [ bing ] [ brave ] [ tavily ] [ serper ] [ exa ]
              │        │        │        │         │        │
              └── per-engine timeout, independent failover ──┘
                 [+ firecrawl, bocha, metaso, linkup, ollama w/ keys]
                              ▼
              Reciprocal Rank Fusion + URL dedup
                              ▼
            ranked results, engine attribution, JSON output
```

Plus two keyless backup engines (AnySearch, Keenable) for when the
baselines degrade, a `doctor` self-check command, and a failure cooldown.

## Quick start

**1. Install** (one command; into Claude Code and any Agent-Skills agent):

```bash
npx skills add xinghe-labs/easy-websearch
```

> Prefer a standalone CLI? `npm install -g easy-websearch` gives you the
> `easy-websearch` command everywhere — no skill folder needed:
> `easy-websearch search "query"` / `easy-websearch doctor`.

**2. Verify** (optional but recommended — no API key needed for this):

```bash
node ~/.agents/skills/easy-websearch/scripts/doctor.mjs
easy-websearch doctor        # same check, via the npm CLI
```

**3. Use it** — just talk to your agent. No configuration, no flags to remember:

> “帮我查一下 rust async runtime 的最新资料” · “search for the latest webgpu news” · “读一下这个网页讲了什么：https://…”

That's it — the baseline (DuckDuckGo + Bing) works with zero API keys.
Optional keys (Brave/Tavily/Serper/Exa/Firecrawl/Bocha/Metaso/Linkup/Ollama)
upgrade the engine pool automatically — see [Install](#install).

## Why easy-websearch

| | built-in web tools | single-engine skills | **easy-websearch** |
|---|---|---|---|
| Works with no API key | agent-dependent | often not | ✅ DDG + Bing baseline |
| Survives engine blocks/rate limits | n/a | ❌ single point of failure | ✅ failover + fusion |
| Chinese sources | varies | rarely tuned | ✅ `cn-zh` / `zh-CN` region tuning, CSDN/知乎/juejin reachable |
| Tells you *which* engines answered | no | no | ✅ per-engine status + per-hit attribution |
| Runtime deps | — | often npm/pip | ✅ zero (Node ≥18 **or** Python ≥3.11 stdlib) |
| Proxy-aware | varies | rarely | ✅ honors `HTTPS_PROXY` (incl. a CONNECT tunnel for Node `fetch`) |

## Optional engine keys — 30 seconds each

Every key is optional. Add one and its engine joins the search pool
automatically. Fastest wins first:

| Order | Engine | What it adds | Free | Sign up (direct link) |
|---|---|---|---|---|
| 1 | **Brave** | stable international results | 2,000/mo | [brave.com/search/api](https://brave.com/search/api/) → Free plan |
| 2 | **Tavily** | LLM-friendly summaries | 1,000/mo | [app.tavily.com](https://app.tavily.com/) |
| 3 | **Ollama** | one more solid source | free account | [ollama.com](https://ollama.com/) → Account → API keys |
| 4 | **Bocha 博查** | best Chinese web results | grant (paid) | [open.bochaai.com](https://open.bochaai.com/) |
| 5 | **Serper** | Google results | trial | [serper.dev](https://serper.dev/) |
| 6 | **Exa** | semantic search | trial | [dashboard.exa.ai](https://dashboard.exa.ai/) |
| 7 | **Firecrawl** | search + better `fetch` | trial | [firecrawl.dev](https://firecrawl.dev/) |
| 8 | **Metaso 秘塔** | Chinese AI search | grant (paid) | [metaso.cn/search-api/api-keys](https://metaso.cn/search-api/api-keys) |
| 9 | **Linkup** | sourced answers | free tier | [linkup.so](https://linkup.so/) |
| — | AnySearch / Keenable | keyless backups (opt-in) | anonymous OK | [anysearch.com](https://anysearch.com/) / [keenable.ai](https://keenable.ai/) |

Put keys in your agent's env (e.g. Claude Code `~/.claude/settings.json`):

```json
{ "env": { "BRAVE_API_KEY": "…", "TAVILY_API_KEY": "…" } }
```

Then `node scripts/doctor.mjs` — each missing key now prints where to get it.

## Self-hosted SearXNG (unlimited, no keys)

Full deployment guide (docker-compose, settings.yml, network gotchas): [`docs/searxng-setup.md`](docs/searxng-setup.md).

If you run [SearXNG](https://docs.searxng.org/) yourself (docker one-liner:
`docker run -p 8080:8080 searxng/searxng`), point the skill at it:

```bash
export SEARXNG_BASE_URL=http://localhost:8080   # or https://searx.example.com
```

The `searxng` engine joins the pool automatically. Two requirements on the
instance side:

1. **JSON format enabled** — in `settings.yml`:
   ```yaml
   search:
     formats:
       - html
       - json
   ```
   (If it's missing, doctor/search reports: `SearXNG rejected JSON — add
   'json' to search.formats in settings.yml`.)
2. **Reachability** — the skill honors `HTTPS_PROXY`; a local instance should
   be reachable directly.

A private instance gives you an unlimited engine with no API keys and no
rate limits — a clean alternative to sharing accounts.

## Install

### npm (global CLI)

```bash
npm install -g easy-websearch
```

Gives you the `easy-websearch` command everywhere — search / fetch / doctor /
setup as subcommands, no skill folder needed:

```bash
easy-websearch search "大模型 本地部署" --lang zh -n 5
easy-websearch fetch "https://example.com/article"
easy-websearch doctor
```

Or run without installing: `npx easy-websearch@latest doctor`

### Claude Code / any Agent Skills runtime

Copy or clone this folder into your skills directory (re-running the add
command updates an existing installation in place):

```bash
# user-level
git clone https://github.com/xinghe-labs/easy-websearch ~/.claude/skills/easy-websearch

# or project-level
git clone https://github.com/xinghe-labs/easy-websearch .claude/skills/easy-websearch
```

With the [skills CLI](https://skills.sh):

```bash
npx skills add xinghe-labs/easy-websearch
```

Verify the install:

```bash
node scripts/doctor.mjs    # every engine: reachable / key missing / cooldown
```

### Optional engine keys

| Key | Engine | Free tier | Get it |
|---|---|---|---|
| `BRAVE_API_KEY` | Brave Search | 2,000/mo | brave.com/search/api |
| `TAVILY_API_KEY` | Tavily | 1,000/mo | tavily.com |
| `SERPER_API_KEY` | Google (Serper) | trial credits | serper.dev |
| `EXA_API_KEY` | Exa (semantic) | trial credits | exa.ai |
| `FIRECRAWL_API_KEY` | Firecrawl | trial credits; also upgrades `fetch` | firecrawl.dev |
| `BOCHA_API_KEY` | 博查 (Chinese web) | paid, free grant | open.bochaai.com |
| `METASO_API_KEY` | 秘塔 Metaso (Chinese AI search) | paid, free grant | metaso.cn/search-api |
| `LINKUP_API_KEY` | Linkup | free tier | linkup.so |
| `OLLAMA_API_KEY` | Ollama web search | free account | ollama.com |
| `ANYSEARCH_API_KEY` | AnySearch | optional — anonymous works with lower limits | anysearch.com |
| `KEENABLE_API_KEY` | Keenable | optional — anonymous works with lower limits | keenable.ai |

All optional. Baseline engines need nothing. The two keyless backup engines
are excluded from the default run (their anonymous quotas are low); enable
with `--engine anysearch,keenable` or `EASY_WEB_SEARCH_ENGINES=anysearch,keenable`.

## Usage

The agent runs these itself when you ask it to search; you can also run them directly.

```bash
# search (Node or Python — both included, zero deps)
node scripts/search.mjs "large language model local deployment" --lang zh -n 5
python3 scripts/search.py "fusion reactor progress 2026" --days 30

# filters
node scripts/search.mjs "webgpu tutorial" --site developer.mozilla.org --exclude-site pinterest.com

# machine-readable
node scripts/search.mjs "qwen3 benchmarks" --json

# read a page as Markdown (auto-falls back to r.jina.ai if blocked)
node scripts/fetch.mjs "https://example.com/some/article"
```

Example output (text mode):

```text
engines:
  ddg: 10 results in 1214ms
  bing: 10 results in 786ms

1. 大模型本地部署保姆级教程 ...
   https://blog.csdn.net/...
   本文分享大模型本地部署基础知识...
   [bing, ddg]          ← hit by both engines ⇒ ranked first
```

<p align="center"><img src="assets/demo.svg" alt="easy-websearch real search output: engines status + fused results" width="720"></p>

## How fusion works

Each engine returns a ranked list. A URL found at rank *r* by an engine
contributes `1/(60+r)` to its score (Reciprocal Rank Fusion). Scores are
summed across engines after URL normalization (tracking params stripped,
Bing `/ck/a` and DDG `/l/?uddg=` redirects decoded), so pages that
*multiple independent engines* agree on rise to the top.

Failure is expected and handled: any engine can time out, get rate-limited,
or serve an anti-bot page — its status is reported, it enters a 10-minute
cooldown (skipped on subsequent default runs; override with `--engine` or
`--no-cooldown`), and fusion proceeds with the rest. If *all* engines fail,
you get their error messages, not silence.

## Health check

```bash
node scripts/doctor.mjs        # per-engine status, latency, config gaps
python3 scripts/doctor.py --json
```

## Troubleshooting

**An engine says `skipped (cooldown: ...)`** — it failed recently (timeout,
bot-block, bad key). Failing engines are skipped for 10 minutes on default
searches so they don't burn every request. State lives in
`$XDG_CACHE_HOME/easy-websearch/cooldowns.json` (`~/.cache/...` by default).
Reset it with `node scripts/doctor.mjs --clear-cooldown`, bypass per-run with
`--no-cooldown`, or name the engine explicitly (`--engine ddg`).

**DDG fails with timeout / HTTP 202** — DuckDuckGo blocks some networks.
Bing stays reachable from most networks; setting `HTTPS_PROXY` also helps
(both runtimes honor it).

**Bing says `bot junk detected`** — Bing served an anti-bot page disguised
as results. The guard failed the engine soft so other engines cover; retry
later or use a keyed engine.

## Requirements

- Node ≥ 18 (`scripts/*.mjs`) or Python ≥ 3.11 (`scripts/*.py`) — one is enough
- Outbound HTTPS. Behind a proxy? Set `HTTPS_PROXY`; both runtimes honor it.

## Known limits (honesty section)

- Baseline HTML scraping (DDG/Bing) can break when engines change markup —
  CI re-probes engines weekly and opens an issue when one dies.
- `--days` is approximate on DDG (day/week/month granularity) and not
  supported by Bing HTML.
- SearXNG public instances were evaluated and dropped for instability
  (see `references/engine-notes.md`); self-hosted SearXNG support is on the roadmap.
- Deep-research multi-step workflow docs land in v2
  (`references/deep-research.md`).

## License

MIT
