# Changelog

All notable changes are summarized here. Full notes per version live in
[`.github/releases/`](.github/releases/) and on the
[Releases page](https://github.com/xinghe-labs/easy-websearch/releases).

## [1.5.0] — 2026-11-07

- **Thicker no-key baseline**: Baidu joins the default pool (Chinese results,
  `/link` wrappers resolved to real URLs); cookie jar added to both runtimes
  (browser-like anti-bot posture, required by Sogou)
- **Sogou Weixin engine** (opt-in vertical): WeChat公众号 article search —
  unique content no other engine covers; `/link` JS-stub decoding
- **Self-hosted SearXNG engine**: set `SEARXNG_BASE_URL` and it joins the
  pool (unlimited, no keys); explicit hint when JSON format is disabled
- **BYOK friction to zero**: doctor SKIP rows now show where to apply for
  each missing key; README/zh gained a “30 seconds per key” guide with
  direct signup links and a SearXNG self-host section
- Rejected after probing: Startpage (captcha-block), Mojeek (403),
  Marginalia (weak) — see `references/engine-notes.md`

## [1.4.0] — 2026-11-07

- **One-command onboarding**: `scripts/setup.mjs` / `setup.py` — detects
  agent skill directories (~/.claude/skills, ~/.agents/skills, project-level),
  installs the skill into them (in-place update on re-run), runs the doctor
  health check from the installed copy, and prints next steps
- README Quick start section (install → verify → talk to your agent),
  bilingual

## [1.3.0] — 2026-11-07

UX-review fixes (see [`docs/ux-review-2026-11-07.md`](docs/ux-review-2026-11-07.md)):

- `--help`/`-h`; unknown flags and missing values now error instead of being
  searched as query terms
- Bing bot-junk guard: unrelated-result pages fail soft instead of surfacing
  garbage (unit-tested, both runtimes)
- Engines status moved to stdout (piped output no longer interleaves)
- Unknown engine names error with the full valid list
- Failure cooldown documented + visible in `doctor`; `--clear-cooldown` added
- `--days` on Bing shows `[days ignored by bing]`; fetch error copy and
  footer stripping improved; docs polish (real repo URLs, doctor step)

## [1.2.0] — 2026-11-07

- Five new keyed engines: Firecrawl, Bocha 博查, Metaso 秘塔, Linkup, Ollama
- `doctor` self-check command (node + python)
- Failure cooldown (10 min, persistent, `--no-cooldown`/`--engine` bypass)
- `fetch` fallback chain: direct → Firecrawl → r.jina.ai
- Fixes: env-key collection for new engines, urllib Content-Type override
  (Bocha 415), Metaso 200-wrapped error shapes

## [1.1.0] — 2026-11-07

- Two keyless backup engines: AnySearch, Keenable (opt-in via `--engine` or
  `EASY_WEB_SEARCH_ENGINES`)
- `fetch.mjs` structured failure instead of crash; node redirect following;
  broader HTML entity decoding

## [1.0.0] — 2026-11-07

- Initial public release: multi-engine search (DuckDuckGo + Bing baseline;
  Brave / Tavily / Serper / Exa via keys) with Reciprocal Rank Fusion,
  per-engine status, URL→Markdown page reader, zero dependencies
  (Node or Python stdlib)
