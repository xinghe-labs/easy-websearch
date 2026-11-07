# Publishing checklist

Steps to ship easy-websearch to the skill marketplaces. Replace `<you>` with
the GitHub username.

## 1. GitHub repo — ✅ DONE 2026-11-07

- [x] Repo live: `xinghe-labs/easy-websearch` (public, main, topics set)
- [x] CI `engine-probe` enabled and passing
- [x] v1.1 tagged, `.github/releases/v1.1.md` written

## 2. Skill directories

| Channel | How | Priority |
|---|---|---|
| [skills.sh](https://skills.sh) | Auto-lists repos installable via `npx skills add <you>/easy-websearch` — verify after push | ⭐ highest traffic |
| [awesomeskill.ai](https://awesomeskill.ai) | Submit URL via site form | high |
| [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills) | PR adding entry to the curated list | high |
| [agentscli marketplace](https://marketplace.agentscli.com) | Submit via catalog form | medium |
| clawhub (openclaw/skills) | Optional; archive of OpenClaw skills | low |

## 3. Ready-to-paste submission copy

### awesomeskill.ai / agentscli form

> **Name:** easy-websearch
> **URL:** https://github.com/xinghe-labs/easy-websearch
> **Category:** web-research
> **Description:** Multi-engine web search + page reader for AI coding agents,
> packaged as a single Agent Skills folder. Works with zero API keys
> (DuckDuckGo + Bing), auto-upgrades with Brave/Tavily/Serper/Exa keys, plus
> keyless backup engines (AnySearch, Keenable). Results are fused across
> engines with Reciprocal Rank Fusion; every hit is attributed to its
> sources; engines fail over independently so blocks and rate-limits never
> kill a search. Zero npm/pip dependencies — Node or Python stdlib only.
> Honors HTTPS_PROXY (built-in CONNECT tunnel). Chinese-source optimized
> (`cn-zh` / `zh-CN`).
> **Tags:** web-search, agent-skills, claude-code, multi-engine, zero-config

### ComposioHQ/awesome-claude-skills PR entry

> - [easy-websearch](https://github.com/xinghe-labs/easy-websearch) —
>   Multi-engine web search skill with RRF fusion and reliability-first
>   failover. Zero API keys required (DDG + Bing baseline; optional Brave /
>   Tavily / Serper / Exa / AnySearch / Keenable), includes a URL-to-Markdown
>   page reader with reader-mode fallback. Zero-dependency scripts (Node or
>   Python). Chinese-source optimized.

Suggested PR title: `Add easy-websearch (multi-engine web search skill)`

### Announcement post — r/ClaudeAI / X (EN)

> **I made a web-search skill that works with zero API keys**
>
> Most search skills die the moment their single engine rate-limits them.
> easy-websearch runs 2 engines by default (DuckDuckGo + Bing — no key
> needed), fuses results with Reciprocal Rank Fusion, and reports exactly
> which engine answered and which failed. Add Brave/Tavily/Serper/Exa keys
> and they join automatically; two more keyless engines (AnySearch, Keenable)
> are available as backups.
>
> - Agent Skills standard: works in Claude Code, Codex, Cursor, Gemini CLI…
> - Zero npm/pip deps — Node or Python stdlib scripts
> - Proxy-aware (honors HTTPS_PROXY; built-in CONNECT tunnel for Node)
> - `--json` output with per-engine status; URL→Markdown page reader included
>
> https://github.com/xinghe-labs/easy-websearch

### 宣传帖 — 掘金 / V2EX（中文）

> **给 AI 编程 agent 做了个免费免 key 的多引擎搜索 skill**
>
> 市面上的搜索 skill 大多绑一个引擎、要一个 key，被反爬就全灭。
> easy-websearch 默认双引擎（DuckDuckGo + Bing，零 key 零配置），结果用
> RRF 融合排序，每条结果标注来自哪些引擎，单引擎被限流自动降级不影响整体。
> 配上 Brave/Tavily/Serper/Exa 的 key 自动升级，还有两个免 key 备援引擎
> （AnySearch、Keenable）兜底。
>
> - Agent Skills 标准：Claude Code / Codex / Cursor / Gemini CLI 都能装
> - 零 npm/pip 依赖：Node 或 Python 标准库脚本
> - 中文优化：`cn-zh` / `zh-CN` 区域参数，CSDN/知乎/掘金结果实测可达
> - 国内友好：Bing 直连保底，有代理自动走代理（Node 内置 CONNECT 隧道）
>
> https://github.com/xinghe-labs/easy-websearch

## 4. Post-release

- [ ] Watch the first issues; engine parser breakage is the most likely kind — `references/engine-notes.md` documents each parser's assumptions
- [ ] v2 scope: deep-research orchestration helpers, self-hosted SearXNG support
