# Changelog

All notable changes are summarized here. Full notes per version live in
[`.github/releases/`](.github/releases/) and on the
[Releases page](https://github.com/xinghe-labs/easy-websearch/releases).

## [1.9.0] — 2026-11-09

- **Owner-requested engine expansion (unfreezes the v1.7.1 list)**: 30 → 34
  engines. New: **Google CSE** (official Google results, free 100/day,
  `GOOGLE_API_KEY` + `GOOGLE_CX`), **Semantic Scholar** (academic papers,
  keyless auto-tier; free `S2_API_KEY` lifts the shared-pool 429s), **Bing
  News** (keyless news vertical, apiclick url= unwrap), **Gitee** (CN code
  search, requires free `GITEE_TOKEN` — anonymous API returns empty arrays)
- Probe-rejected: m.sogou.com mobile variant (JS-resolved targets,
  unextractable zero-dep) — engine-notes
- Intent routing: 新闻/快讯 → Bing News; 学术 queries now also hit Semantic
  Scholar; Gitee routes only when tokened (zero noise without keys)
- Docs: verified free-tier table for all keyed engines (README both langs);
  SKILL.md env guide extended

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

## [1.7.0] — 2026-11-07

- **7 个垂直引擎**（官方免 key API，双运行时）：wikipedia / stackexchange /
  hn / github / 掘金 juejin / arxiv / mwmbl —— 官方 API 免疫反爬，可用性有保障
- **查询意图路由**：code→github、报错→stackexchange、论文→arxiv、
  什么是→wikipedia、科技新闻→hn、掘金/前端→juejin（保守模式，仅强信号触发，
  避免烧配额）；路由函数导出可单测
- **SearXNG basic-auth 支持**：`SEARXNG_BASE_URL=https://user:pass@host`
  （Caddy/nginx 鉴权实例可用；node fetch 拒绝 userinfo URL、py urllib 解析
  错误 —— 双运行时改为显式提取凭据发送 Authorization 头，httpbin 实测）
- **wikipedia 引擎超时加长**（1.5×，≥12s）：慢代理路径实测 5-9s，通用 8s
  超时卡死；e2e 加可达性预检（被 GFW/代理阻断的网络 SKIP，CI 可达正常验证）
- **冷却递增**：首败 2 分钟、连败 10 分钟（瞬态网络抖动快恢复）
- **--direct / EASY_WEB_SEARCH_DIRECT=1**：强制全引擎绕过代理（代理出口
  被反爬的场景）
- doctor 代理提示、searxng basic-auth、README 重构去重、npm 徽章

## [1.6.1] — 2026-11-07

- **免 key 基线加厚**：搜狗网页 + 360 搜索进默认池（中文基线 1→3 源）
- `/link` 包装链接解析的 base 主机参数化（修复搜狗网页解析）
- doctor 代理提示抓取清单扩展；e2e 扩至 37 项

## [1.6.0] — 2026-11-07

UX review v2 落地（[`docs/ux-review-2026-11-07-v2.md`](docs/ux-review-2026-11-07-v2.md)）：

- **`--direct` / `EASY_WEB_SEARCH_DIRECT=1`**（P1-1+P2-3）：强制所有引擎绕过
  代理 —— 解决"挂代理的国内用户 4 个基线引擎被数据中心出口反爬集体拦截"
- **doctor 代理提示**（P1-1）：检测到代理且 ≥2 个抓取引擎失败时，文本/JSON
  输出明确提示绕过手段（双运行时）
- **冷却时长递增**（P3-6）：首次失败 2 分钟（瞬时抖动快恢复），连败升 10
  分钟；成功即清零（双运行时）
- **fetch 错误文案**（P3-7）：reader 被拒场景补充说明
- 文档（P1-2/P2-4/P2-5）：README 双语新增「代理用户推荐引擎池」、
  `npx easy-websearch setup` 安装路径、「国内用户 npm 路径更稳」注记

## [1.5.1] — 2026-11-07

- npm 正式发布 `easy-websearch@1.5.1`：`npm install -g easy-websearch` 或 `npx easy-websearch doctor` 免安装体验（README 已加 npm 安装文档）
- fix: npm bin dispatcher 脚本路径（npx doctor 此前 MODULE_NOT_FOUND）
- fix: searxng 未配置 env 时给出明确引导提示；basic-auth 支持（user:pass@）
