# Contributing to easy-websearch

Thanks for considering a contribution! This repo is intentionally small:
a skill folder with zero-dependency scripts in two runtimes.

## Repo layout

```text
SKILL.md              agent-facing instructions (triggers, workflow)
scripts/search.mjs    search engine (Node, zero deps)     ← reference implementation
scripts/search.py     search engine (Python stdlib twin) ← keep in sync!
scripts/fetch.mjs     URL → Markdown reader (Node)
scripts/fetch.py      reader (Python twin)
scripts/doctor.*      engine health check
tests/e2e.sh          network-dependent end-to-end matrix
tests/parity.sh       offline matrix × both runtimes (unit + parser snapshots)
tests/snapshots/      trimmed real markup fed to the SERP parsers
references/           engine schemas & research workflow notes
```

## Ground rules

- **Zero dependencies.** Scripts use Node core modules / Python stdlib only.
- **Twins stay in sync.** Every behavior change to `search.mjs`/`fetch.mjs`
  must land in the `.py` twin in the same PR (and vice versa). The offline
  guard is `bash tests/parity.sh` — the same assertion matrix (pure functions
  + parser snapshots) must pass in both runtimes; it also runs in CI
  (`.github/workflows/unit-parity.yml`).
- **Parser changes need a snapshot.** When you touch or add a SERP parser,
  trim a real markup sample into `tests/snapshots/` and cover it in
  `tests/parsers.test.mjs` + `tests/parsers_test.py` (keep the two test
  files in lockstep). Markup drift from engine redesigns then fails offline
  instead of in production.
- **Reliability-first.** An engine failure must degrade (throw a clear error,
  be caught by the runner), never crash the whole run.
- **Honest output.** Report per-engine status; never invent or silently drop
  results.

## Adding an engine

1. Verify the API contract against its live docs; record it in
   [`references/engine-notes.md`](references/engine-notes.md).
2. Implement `engineXxx(ctx)` in both `search.mjs` and `search.py`:
   input `ctx = {query, n, days, lang, timeout, env}`, output
   `[{title, url, snippet}]`. Throw on failure — the runner isolates engines.
3. Register it in `ENGINES` (both files): baseline (no key), keyed, or backup
   (`optional_key`/`backup` flags).
4. Add the key to the env-collection list in `search.py` `main()` — this is
   easy to miss and has bitten us before (see v1.2 notes).
5. Extend `tests/e2e.sh` (keyed-hidden-without-key, opt-in behavior) and
   `doctor.*` needs no change (it enumerates `ENGINES`).
6. Update `SKILL.md`, `README.md`, `README.zh-CN.md` engine lists and
   `CHANGELOG.md`.

## Testing

```bash
bash tests/e2e.sh          # needs node (+ python3 for the py twin checks)
node scripts/doctor.mjs    # quick engine sanity
```

The e2e suite hits real engines; CI (`engine-probe` workflow) runs a smaller
weekly probe and files an issue when a baseline parser breaks.

## PRs

- One logical change per PR; include before/after command output for
  behavior changes.
- Update `CHANGELOG.md` (unreleased section or the next version).
- If a scraper breaks, `references/engine-notes.md` documents each parser's
  assumptions — start there.
