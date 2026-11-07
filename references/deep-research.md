# Deep Research Workflow (v2 preview)

This document defines the multi-step research workflow built on top of the
v1 `search` + `fetch` scripts. It ships as guidance for the agent — no extra
code required — and will be expanded in v2 with orchestration helpers.

## When to use

Broad requests where one search is not enough: "research X", "compare A vs B
vs C", "what's the state of X in 2026", "帮我调研", "全面了解一下".

## Workflow

1. **Decompose** the request into 3-6 sub-questions covering distinct angles.
   For China-relevant topics include at least one Chinese sub-query
   (`--lang zh`) and one English one.
2. **Search** each sub-question independently with `--json`:
   ```bash
   node scripts/search.mjs "<sub-question>" --json --lang zh -n 8
   ```
3. **Fetch** the 2-3 most promising URLs per sub-question:
   ```bash
   node scripts/fetch.mjs "<url>" --json --max-chars 12000
   ```
4. **Cross-validate**: claims found in only one fetched source are marked
   single-source. Claims confirmed across independent domains (or by hits
   ranked via multiple engines) are treated as established.
5. **Synthesize** into a report:
   - Answer-first summary (≤ 5 bullets)
   - Findings per sub-question, inline source links
   - A "confidence" note: established / single-source / conflicting
   - Per-engine coverage note when relevant (e.g. "DDG was rate-limited
     during this research; results lean on Bing+Serper")

## Budget

- ≤ 8 search calls and ≤ 12 fetch calls per research task by default.
- Stop early when sub-questions start returning the same URL set — that is
  saturation, more queries add noise, not information.
