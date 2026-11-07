---
name: Engine broken
about: A baseline engine (ddg/bing) stopped returning results or parses garbage
labels: engines, ci
---

**Which engine**: ddg / bing / other
**Symptom**: timeout / HTTP error / junk results / `bot junk detected` / 0 results parsed
**Did the weekly `engine-probe` CI open an issue?** yes/no

**Output** (paste the engine status line + a few result titles/URLs):

```text
…
```

**Your network**: country/region, proxy in use?

> Baseline engines are scraped HTML — when their markup or anti-bot rules
> change, parsers break. `references/engine-notes.md` documents each parser's
> assumptions; a screenshot or `curl` dump of the current SERP HTML helps a lot.
