# Publishing checklist

Steps to ship fusion-search to the skill marketplaces. Replace `<you>` with
the GitHub username.

## 1. GitHub repo

- [ ] Create public repo `<you>/fusion-search` (description: "Zero-config multi-engine web search skill for AI agents — free without API keys")
- [ ] `git remote add origin git@github.com:<you>/fusion-search.git && git push -u origin main`
- [ ] About topics: `agent-skills`, `claude-code`, `web-search`, `skill`, `ai-agents`, `search`
- [ ] Enable Issues; keep the `engine-probe` workflow enabled (Settings → Actions)

## 2. Skill directories

| Channel | How | Priority |
|---|---|---|
| [skills.sh](https://skills.sh) | Auto-lists repos installable via `npx skills add <you>/fusion-search` — verify after push | ⭐ highest traffic |
| [awesomeskill.ai](https://awesomeskill.ai) | Submit URL via site form | high |
| [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills) | PR adding entry to the curated list | high |
| [agentscli marketplace](https://marketplace.agentscli.com) | Submit via catalog form | medium |
| clawhub (openclaw/skills) | Optional; archive of OpenClaw skills | low |

## 3. Announcement posts

- [ ] r/ClaudeAI or X thread: angle = "web search skill that works with zero API keys and survives engine blocks (multi-engine fusion)"
- [ ] 掘金 / V2EX: angle = 中文源优化 + 国内无代理可用（Bing 直连保底）
- [ ] Include one GIF/terminal capture of `search.mjs --json` output

## 4. Post-release

- [ ] Watch the first issues; engine parser breakage is the most likely kind — `references/engine-notes.md` documents each parser's assumptions
- [ ] v2 scope: deep-research orchestration helpers, self-hosted SearXNG support
