# easy-web-search（中文说明）

[![engine-probe](https://github.com/xinghe-labs/easy-websearch/actions/workflows/engine-probe.yml/badge.svg)](https://github.com/xinghe-labs/easy-websearch/actions/workflows/engine-probe.yml)
[![Release](https://img.shields.io/github/v/release/xinghe-labs/easy-websearch)](https://github.com/xinghe-labs/easy-websearch/releases)
[![npm](https://img.shields.io/npm/v/easy-websearch)](https://www.npmjs.com/package/easy-websearch)
[![npm downloads](https://img.shields.io/npm/dw/easy-websearch)](https://www.npmjs.com/package/easy-websearch)
[![License: MIT](https://img.shields.io/badge/License-MIT-2F9E4F.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-%E2%89%A518-3C873A)
![Python](https://img.shields.io/badge/Python-%E2%89%A53.11-3776AB)

[English](README.md) | 简体中文

> 面向 AI 编程 agent 的多引擎网页搜索 + 网页正文读取，单文件夹即是一个
> [Agent Skills](https://agentskills.io) 标准技能。

**零配置**：不配任何 API key 也能用（DuckDuckGo + Bing + 百度基线）。
**配 key 更强**：11 个可选 key（Brave、Tavily、Serper、Exa、Firecrawl、博查、
秘塔、Linkup、Ollama、AnySearch、Keenable —— 见下方
[引擎 key 表](#引擎-key全部可选))配好后对应引擎自动加入。失败的引擎会
进入 10 分钟冷却期，单个坏引擎不会拖垮整个请求。

```text
查询 ──► [ ddg ] [ bing ] [ baidu ] [ brave ] [ tavily ] [ serper ] [ exa ]
              │        │        │        │        │         │        │
              └──────── 单引擎超时，独立降级互不影响 ─────────┘
                 ［配 key 后自动加入：firecrawl / bocha / metaso / linkup / ollama / searxng］
                              ▼
                RRF 倒数排名融合 + URL 去重
                              ▼
          排序结果、来源引擎标注、JSON 结构化输出
```

另有免 key 备援引擎（AnySearch、Keenable、搜狗微信）在基线降级时兜底，
以及 `doctor` 自检命令和失败冷却机制。

## 快速上手

**1. 安装** —— 二选一（也可共存）：

```bash
npx skills add xinghe-labs/easy-websearch      # 装为 agent 技能
npm install -g easy-websearch                  # 或装为全局命令行
```

**2. 验证**（可选但推荐 —— 这一步不需要任何 API key）：

```bash
easy-websearch doctor                                    # npm 安装路径
node ~/.agents/skills/easy-websearch/scripts/doctor.mjs  # skills 安装路径
```

**3. 使用** —— 直接对 agent 说话，或跑命令行。无需配置，无需记参数：

> “帮我查一下 rust async runtime 的最新资料” · “search for the latest webgpu news” · “读一下这个网页讲了什么：https://…”

```bash
easy-websearch search "大模型 本地部署" --lang zh -n 5
```

到此为止 —— 基线（DuckDuckGo + Bing + 百度）零 API key 可用；可选 key 会
自动升级引擎池（见[引擎 key 表](#引擎-key全部可选））。

## 为什么选 easy-web-search

| | agent 内置搜索 | 单引擎类 skill | **easy-web-search** |
| --- | --- | --- | --- |
| 无 API key 可用 | 看 agent 脸色 | 通常不行 | ✅ DDG + Bing + 百度基线 |
| 引擎被反爬/限流时 | 不可控 | ❌ 单点故障 | ✅ 自动降级 + 多源融合 + 冷却 |
| 中文信息源 | 不稳定 | 很少调优 | ✅ `cn-zh` / `zh-CN` 区域调优，百度 + CSDN/知乎/掘金可达 |
| 告诉你哪些引擎答了 | 否 | 否 | ✅ 每引擎状态 + 每条结果来源标注 |
| 运行时依赖 | — | 常 npm/pip | ✅ 零依赖（Node ≥18 **或** Python ≥3.11 标准库） |
| 代理感知 | 不一定 | 很少 | ✅ 读取 `HTTPS_PROXY`（Node 内置 CONNECT 隧道） |

<p align="center"><img src="assets/demo.svg" alt="easy-websearch real search output: engines status + fused results" width="720"></p>

## 安装

两种安装形态 —— 按用途选择（可共存）：

### 作为 agent 技能（Claude Code / Codex / Cursor / Gemini CLI…）

装好后 agent 会在你要求搜索时自动调用。

```bash
# skills CLI（重复执行即原地更新）
npx skills add xinghe-labs/easy-websearch

# 或直接克隆
git clone https://github.com/xinghe-labs/easy-websearch ~/.claude/skills/easy-websearch
```

> 国内网络注意：直连 GitHub 可能不稳定（TLS 握手偶发失败）—— **npm 路径**
> （`npm install -g easy-websearch`）完全不碰 GitHub，是国内最可靠的安装方式。

### 作为全局命令行（自己的终端）

```bash
npm install -g easy-websearch
```

全局安装后随处可用 `easy-websearch` 命令 —— search / fetch / doctor /
setup 四个子命令。或免安装直接跑：`npx easy-websearch@latest doctor`

```bash
easy-websearch search "大模型 本地部署" --lang zh -n 5
easy-websearch fetch "https://example.com/article"
easy-websearch doctor
```

### 引擎 key（全部可选）

所有 key 都可选。配一个，对应引擎自动加入搜索池。按性价比排序：

| 顺序 | 引擎 | 带来什么 | 免费额度 | 注册直达 | 环境变量 |
| --- | --- | --- | --- | --- | --- |
| 1 | **Brave** | 稳定的国际搜索 | 2,000 次/月 | [brave.com/search/api](https://brave.com/search/api/) → Free 计划 | `BRAVE_API_KEY` |
| 2 | **Tavily** | LLM 友好摘要 | 1,000 次/月 | [app.tavily.com](https://app.tavily.com/) | `TAVILY_API_KEY` |
| 3 | **Ollama** | 多一个稳定源 | 免费账号 | [ollama.com](https://ollama.com/) → Account → API keys | `OLLAMA_API_KEY` |
| 4 | **博查 Bocha** | 最强中文网页搜索 | 新客额度（付费） | [open.bochaai.com](https://open.bochaai.com/) | `BOCHA_API_KEY` |
| 5 | **Serper** | Google 结果 | 试用额度 | [serper.dev](https://serper.dev/) | `SERPER_API_KEY` |
| 6 | **Exa** | 语义搜索 | 试用额度 | [dashboard.exa.ai](https://dashboard.exa.ai/) | `EXA_API_KEY` |
| 7 | **Firecrawl** | 搜索 + fetch 抓取升级 | 试用额度 | [firecrawl.dev](https://firecrawl.dev/) | `FIRECRAWL_API_KEY` |
| 8 | **秘塔 Metaso** | 中文 AI 搜索 | 新客额度（付费） | [metaso.cn/search-api/api-keys](https://metaso.cn/search-api/api-keys) | `METASO_API_KEY` |
| 9 | **Linkup** | 带引用的回答 | 免费额度 | [linkup.so](https://linkup.so/) | `LINKUP_API_KEY` |
| — | AnySearch / Keenable | 免 key 备援（需 opt-in） | 匿名可用 | [anysearch.com](https://anysearch.com/) / [keenable.ai](https://keenable.ai/) | `ANYSEARCH_API_KEY` / `KEENABLE_API_KEY` |

key 放进 agent 的环境变量（如 Claude Code 的 `~/.claude/settings.json`）：

```json
{ "env": { "BRAVE_API_KEY": "…", "TAVILY_API_KEY": "…" } }
```

然后 `easy-websearch doctor`（或 `node scripts/doctor.mjs`）—— 每个缺失的
key 现在都会显示去哪申请。

## 自建 SearXNG（无配额、无 key）

完整部署指南（docker-compose、settings.yml、远程服务器、NAT、网络注意
事项）：[`docs/searxng-setup.md`](docs/searxng-setup.md)。

如果你自己跑 [SearXNG](https://docs.searxng.org/)（docker 一行：
`docker run -p 8080:8080 searxng/searxng`），把 skill 指向它：

```bash
export SEARXNG_BASE_URL=http://localhost:8080   # 或 https://searx.example.com
```

`searxng` 引擎自动加入。实例侧两个要求：

1. **开启 JSON 格式** —— 在 `settings.yml`：

   ```yaml
   search:
     formats:
       - html
       - json
   ```

   （缺了的话，doctor/搜索会提示：`SearXNG rejected JSON — add
   'json' to search.formats in settings.yml`。）
2. **可达性** —— skill 会遵守 `HTTPS_PROXY`；本地实例应直连可达。

私有实例 = 无配额、无 API key 的额外引擎，也是替代“共享账号”的干净方案。

## 用法

```bash
# 搜索（Node / Python 双实现，均零依赖）
node scripts/search.mjs "大模型 本地部署" --lang zh -n 5
python3 scripts/search.py "fusion reactor progress 2026" --days 30

# 过滤参数
node scripts/search.mjs "webgpu 教程" --site developer.mozilla.org --exclude-site pinterest.com

# 结构化输出（供 agent 二次处理）
node scripts/search.mjs "qwen3 评测" --json

# 读网页正文为 Markdown（被反爬时自动降级：直连 → Firecrawl → r.jina.ai）
node scripts/fetch.mjs "https://example.com/some/article"
```

输出示例（文本模式）：

```text
engines:
  ddg: 10 results in 1214ms
  bing: 10 results in 786ms

1. 大模型本地部署保姆级教程 ...
   https://blog.csdn.net/...
   本文分享大模型本地部署基础知识...
   [bing, ddg]          ← 双引擎同时命中 ⇒ 排名靠前
```

## 融合排序原理

每个引擎返回自己的排名列表。某 URL 在某引擎排第 *r* 名，就贡献
`1/(60+r)` 分（RRF 倒数排名融合）。URL 先做归一化（去跟踪参数、解码
Bing `/ck/a` 和 DDG `/l/?uddg=` 跳转），跨引擎累加后排序——**多个独立
引擎都认可的页面自然浮到顶部**。

失败是预期内的：任何引擎都可能超时、被限流或吃到反爬页——它的状态会被
如实标注，并进入 10 分钟冷却（后续默认搜索自动跳过；用 `--engine` 或
`--no-cooldown` 可强制重试），融合继续用剩下的源。全部引擎都失败时，你
会拿到各引擎的错误信息，而不是沉默。

## 健康自检与故障排查

```bash
easy-websearch doctor          # 每引擎状态、延迟、配置缺失一目了然
node scripts/doctor.mjs        # 同上（skill 目录内）
python3 scripts/doctor.py --json
```

**某引擎显示 `skipped (cooldown: ...)`** —— 它最近失败过（超时/反爬/key 错
误）。失败引擎会在后续默认搜索中被跳过 10 分钟，避免每次都白烧请求。状态
存在 `$XDG_CACHE_HOME/easy-websearch/cooldowns.json`（默认 `~/.cache/...`）。
用 `easy-websearch doctor --clear-cooldown` 重置；单次用 `--no-cooldown`
绕过；或显式点名引擎（`--engine ddg`）。

**DDG 超时 / HTTP 202** —— DuckDuckGo 封锁部分网络。Bing 在多数网络可达；
设置 `HTTPS_PROXY` 也有帮助（两个运行时都会遵守）。

**Bing 提示 `bot junk detected`** —— Bing 返回了伪装成结果的反爬页。护栏
已让该引擎软失败、其他引擎接管；稍后重试或改用配 key 的引擎。

## 环境要求

- Node ≥ 18（`scripts/*.mjs`）或 Python ≥ 3.11（`scripts/*.py`）—— 有其一即可
- 能出网。走代理？设好 `HTTPS_PROXY`，两个运行时都会遵守。

## 已知边界（如实说明）

- 基线 HTML 解析（DDG/Bing）在引擎改版时会失效——CI 每周探测并自动开
  issue，通常在用户撞上之前就能发现
- `--days` 在 DDG 上是近似值（日/周/月粒度），Bing HTML 不支持
- 百度/搜狗的反爬页对客户端指纹敏感：node 运行时稳定通过，python 运行时
  可能间歇命中验证页——这两个引擎会软失败，其他引擎兜底
- 深度研究多步工作流文档在 v2 落地（`references/deep-research.md`）

## 许可证

MIT
