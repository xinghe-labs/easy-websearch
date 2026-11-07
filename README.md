# easy-websearch

Multi-engine web search + page reader for AI coding agents — as a single
[Agent Skills](https://agentskills.io)-compatible skill folder.

**Zero-config**: works with no API key at all (DuckDuckGo + Bing baseline).
**Better with keys**: set `BRAVE_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY`,
or `EXA_API_KEY` and those engines join the pool automatically. Two more
keyless engines (AnySearch, Keenable) are available as opt-in backups
(`EASY_WEB_SEARCH_ENGINES=anysearch,keenable`) for extra coverage.

```text
query ──► [ ddg ] [ bing ] [ brave ] [ tavily ] [ serper ] [ exa ]
              │        │        │        │         │        │
              └── per-engine timeout, independent failover ──┘
                              ▼
              Reciprocal Rank Fusion + URL dedup
                              ▼
            ranked results, engine attribution, JSON output
```

Plus two keyless backup engines (AnySearch, Keenable) for when the
baselines degrade.

## Why easy-websearch

| | built-in web tools | single-engine skills | **easy-websearch** |
|---|---|---|---|
| Works with no API key | agent-dependent | often not | ✅ DDG + Bing baseline |
| Survives engine blocks/rate limits | n/a | ❌ single point of failure | ✅ failover + fusion |
| Chinese sources | varies | rarely tuned | ✅ `cn-zh` / `zh-CN` region tuning, CSDN/知乎/juejin reachable |
| Tells you *which* engines answered | no | no | ✅ per-engine status + per-hit attribution |
| Runtime deps | — | often npm/pip | ✅ zero (Node ≥18 **or** Python ≥3.11 stdlib) |
| Proxy-aware | varies | rarely | ✅ honors `HTTPS_PROXY` (incl. a CONNECT tunnel for Node `fetch`) |

## Install

### Claude Code / any Agent Skills runtime

Copy or clone this folder into your skills directory:

```bash
# user-level
git clone https://github.com/<you>/easy-websearch ~/.claude/skills/easy-websearch

# or project-level
git clone https://github.com/<you>/easy-websearch .claude/skills/easy-websearch
```

With the [skills CLI](https://skills.sh):

```bash
npx skills add <you>/easy-websearch
```

### Optional engine keys

| Key | Engine | Free tier | Get it |
|---|---|---|---|
| `BRAVE_API_KEY` | Brave Search | 2,000/mo | brave.com/search/api |
| `TAVILY_API_KEY` | Tavily | 1,000/mo | tavily.com |
| `SERPER_API_KEY` | Google (Serper) | trial credits | serper.dev |
| `EXA_API_KEY` | Exa (semantic) | trial credits | exa.ai |
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

## How fusion works

Each engine returns a ranked list. A URL found at rank *r* by an engine
contributes `1/(60+r)` to its score (Reciprocal Rank Fusion). Scores are
summed across engines after URL normalization (tracking params stripped,
Bing `/ck/a` and DDG `/l/?uddg=` redirects decoded), so pages that
*multiple independent engines* agree on rise to the top.

Failure is expected and handled: any engine can time out, get rate-limited,
or serve an anti-bot page — its status is reported and fusion proceeds with
the rest. If *all* engines fail, you get their error messages, not silence.

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
