#!/usr/bin/env node
/**
 * easy-websearch — multi-engine web search with RRF fusion and graceful degradation.
 * Zero npm dependencies. Node >= 18.
 *
 * Usage:
 *   node search.mjs "query" [-n 10] [--days 7] [--site example.com]
 *        [--exclude-site foo.com] [--lang zh] [--engine ddg,bing]
 *        [--timeout 8] [--json]
 *
 * Engines (baseline, no key): ddg, bing
 * Engines (enabled when env key present): brave (BRAVE_API_KEY),
 *   tavily (TAVILY_API_KEY), serper (SERPER_API_KEY), exa (EXA_API_KEY)
 * Backup engines (keyless, low anonymous quota — off by default; opt in via
 *   --engine or EASY_WEB_SEARCH_ENGINES=anysearch,keenable):
 *   anysearch (ANYSEARCH_API_KEY optional), keenable (KEENABLE_API_KEY optional)
 *
 * Reliability-first: each engine runs independently with its own timeout;
 * failures never abort the run. Output reports per-engine status.
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DEFAULT_TIMEOUT = 8000;
const RRF_K = 60;

// ---------------------------------------------------------------- args ----
const USAGE = 'Usage: node search.mjs "query" [-n 10] [--days 7] [--site d] [--exclude-site d] [--lang zh] [--engine ddg,bing] [--timeout 8] [--no-cooldown] [--json]';

const VALUE_FLAGS = new Set(["-n", "--num", "--days", "--site", "--exclude-site", "--lang", "--engine", "--timeout"]);
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, "--json", "--no-cooldown", "--help", "-h"]);

function printHelp() {
  console.log(USAGE);
  console.log(`
Engines: ddg, bing (baseline, no key) | brave, tavily, serper, exa,
  firecrawl, bocha, metaso, linkup, ollama (auto-enabled by their *_API_KEY)
  | anysearch, keenable (keyless backups, opt-in via --engine or
  EASY_WEB_SEARCH_ENGINES)
Options:
  -n, --num <k>           max results (default 10)
  --days <n>              time window (ddg: day/week/month; exa: exact; bocha: freshness)
  --site <domain>         restrict to domain (repeatable)
  --exclude-site <domain> exclude domain (repeatable)
  --lang <zh|en>          language/region boost
  --engine <a,b,c>        restrict/enable engines (comma-separated)
  --timeout <sec>         per-engine timeout (default 8)
  --no-cooldown           ignore the failure cooldown for this run
  --json                  machine-readable output
  -h, --help              show this help
See README.md for details. Run scripts/doctor.mjs to check engine health.`);
}

function parseArgs(argv) {
  const args = {
    query: "", n: 10, days: 0, site: [], excludeSite: [], lang: "",
    engines: "", timeout: DEFAULT_TIMEOUT, json: false, noCooldown: false,
    help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { args.help = true; continue; }
    if (a.startsWith("-") && a !== "-" && !KNOWN_FLAGS.has(a)) {
      console.error(`Unknown option: ${a}\n${USAGE}\nRun with --help for details.`);
      process.exit(2);
    }
    if (VALUE_FLAGS.has(a) && (i + 1 >= argv.length || argv[i + 1].startsWith("-"))) {
      console.error(`Missing value for option: ${a}\n${USAGE}`);
      process.exit(2);
    }
    if (a === "-n" || a === "--num") args.n = parseInt(argv[++i], 10) || 10;
    else if (a === "--days") args.days = parseInt(argv[++i], 10) || 0;
    else if (a === "--site") args.site.push(argv[++i]);
    else if (a === "--exclude-site") args.excludeSite.push(argv[++i]);
    else if (a === "--lang") args.lang = argv[++i];
    else if (a === "--engine") args.engines = argv[++i];
    else if (a === "--timeout") args.timeout = (parseInt(argv[++i], 10) || 8) * 1000;
    else if (a === "--json") args.json = true;
    else if (a === "--no-cooldown") args.noCooldown = true;
    else rest.push(a);
  }
  args.query = rest.join(" ").trim();
  return args;
}

// ------------------------------------------------------------- fetch ----
// Node's fetch() ignores HTTP(S)_PROXY; many users (esp. behind the GFW)
// need it. Implement a minimal CONNECT tunnel ourselves. Zero-dep.
function proxyConnect(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    let pu;
    try { pu = new URL(proxyUrl); } catch { return reject(new Error(`invalid proxy URL: ${proxyUrl}`)); }
    const req = http.request({
      host: pu.hostname,
      port: parseInt(pu.port, 10) || 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
    });
    req.setTimeout(DEFAULT_TIMEOUT, () => req.destroy(new Error("proxy connect timeout")));
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else { socket.destroy(); reject(new Error(`proxy CONNECT ${res.statusCode}`)); }
    });
    req.on("error", reject);
    req.end();
  });
}

function fetchText(url, { method = "GET", headers = {}, body, timeout = DEFAULT_TIMEOUT } = {}, depth = 0) {
  let u;
  try { u = new URL(url); } catch { return Promise.reject(new Error(`invalid URL: ${url}`)); }
  const isHttps = u.protocol === "https:";
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || "";
  const mod = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout);
    const finish = (fn, val) => { clearTimeout(timer); fn(val); };
    const opts = {
      method,
      headers: {
        "user-agent": UA,
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        ...headers,
      },
    };
    if (proxy && isHttps) {
      // Socket is tunneled; request must address the target via the socket.
      proxyConnect(proxy, u.hostname, u.port || 443).then((socket) => {
        const req = mod.request(
          { ...opts, socket, servername: u.hostname, host: u.hostname, port: u.port || 443, path: u.pathname + u.search },
          handler
        );
        req.on("error", (e) => finish(reject, e));
        if (body) req.write(body);
        req.end();
      }, (e) => finish(reject, e));
    } else {
      const req = mod.request(url, opts, handler);
      req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
      req.on("error", (e) => finish(reject, e));
      if (body) req.write(body);
      req.end();
    }
    function handler(res) {
      // Follow up to 3 redirects — Bing (and others) 302-redirect on direct
      // (non-proxied) connections, e.g. to regional hosts.
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth < 3) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        fetchText(next, { method, headers, body, timeout }, depth + 1).then(
          (v) => finish(resolve, v),
          (e) => finish(reject, e)
        );
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => finish(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }
  });
}

// ------------------------------------------------------------ helpers ----
function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`invalid JSON response: ${e.message}`);
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "", middot: "·", mdash: "—", ndash: "–", hellip: "…", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", copy: "©", "#39": "'", "#x27": "'" };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e) => {
    if (ENTITIES[e]) return ENTITIES[e];
    if (e[0] === "#") {
      const num = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : m;
    }
    return m;
  });
}
const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    [...x.searchParams.keys()].filter((k) => /^(utm_|ref|fbclid)/i.test(k)).forEach((k) => x.searchParams.delete(k));
    let s = x.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch { return u; }
}

function buildQuery(args) {
  let q = args.query;
  for (const s of args.site) q += ` site:${s}`;
  for (const s of args.excludeSite) q += ` -site:${s}`;
  return q.trim();
}

// ------------------------------------------------------------- engines ----
// Each engine: async (ctx) => [{title, url, snippet}]. Throw on failure —
// the runner catches and records per-engine status.

async function engineDDG(ctx) {
  const params = new URLSearchParams({ q: ctx.query, nost: "1" });
  if (ctx.lang === "zh") params.set("kl", "cn-zh");
  else if (ctx.lang === "en") params.set("kl", "us-en");
  if (ctx.days > 0) params.set("df", ctx.days <= 1 ? "d" : ctx.days <= 7 ? "w" : "m");
  const { status, body } = await fetchText("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const results = [];
  // Anchors: <a rel="nofollow" class="result__a" href="...">Title</a>, snippets follow.
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(body)) && results.length < ctx.n * 2) {
    let href = decodeEntities(m[1]);
    const ud = href.match(/[?&]uddg=([^&]+)/);
    if (ud) href = decodeURIComponent(ud[1]);
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(href)) continue; // anomaly/challenge page guard
    results.push({ title, url: href, snippet: "" });
  }
  // Snippets appear after each anchor in document order.
  const snRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let i = 0, s;
  while ((s = snRe.exec(body)) && i < results.length) results[i++].snippet = stripTags(s[1]);
  if (results.length === 0 && /anomaly|challenge|captcha/i.test(body)) throw new Error("blocked (anomaly page)");
  return results;
}

// Bing bot-junk guard: under automation pressure Bing serves HTTP 200 pages
// of unrelated results (observed: "webgpu" → Google homepage / Baidu baike)
// instead of a clean failure. Detect the classic junk shapes and fail soft —
// the cooldown + other engines take over.
function looksLikeJunk(results, query) {
  if (results.length < 2) return false;
  const hostOf = (r) => { try { return new URL(r.url).hostname.replace(/^www\./, ""); } catch { return r.url; } };
  const pathOf = (r) => { try { return new URL(r.url).pathname; } catch { return null; } };
  // 1) every result on the same domain is a bot page, not an SERP
  const hosts = new Set(results.map(hostOf));
  if (results.length >= 3 && hosts.size === 1) return true;
  // 2) real SERPs deep-link; a page of bare homepages is a bot page
  const rootCount = results.filter((r) => ["", "/"].includes(pathOf(r))).length;
  if (results.length >= 2 && rootCount >= Math.ceil(results.length * 0.8)) return true;
  // 3) latin-script queries: no query word appears in any title/url
  const words = query.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g);
  if (words && words.length) {
    const anyHit = results.some((r) => {
      const hay = `${r.title} ${r.url}`.toLowerCase();
      return words.some((w) => hay.includes(w));
    });
    if (!anyHit) return true;
  }
  return false;
}

async function engineBing(ctx) {
  const params = new URLSearchParams({ q: ctx.query });
  if (ctx.lang === "zh") { params.set("mkt", "zh-CN"); params.set("setlang", "zh"); }
  else if (ctx.lang === "en") { params.set("mkt", "en-US"); params.set("setlang", "en"); }
  const { status, body } = await fetchText(`https://www.bing.com/search?${params}`, {
    timeout: ctx.timeout,
    headers: { referer: "https://www.bing.com/", "upgrade-insecure-requests": "1" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const results = [];
  const liRe = /<li class="b_algo"[\s\S]*?<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(body)) && results.length < ctx.n * 2) {
    let url = decodeEntities(m[1]);
    // Bing wraps targets in /ck/a click-tracking redirects; the real URL is
    // base64 (sometimes "a1"-prefixed) inside the u= param. Decode when present.
    const u = url.match(/[?&]u=a1?([A-Za-z0-9+/=]+)/);
    if (u) {
      try {
        const decoded = Buffer.from(u[1], "base64").toString("utf8");
        if (/^https?:\/\//.test(decoded)) url = decoded;
      } catch { /* keep the redirect URL */ }
    }
    const title = stripTags(m[2]);
    const snip = stripTags(m[3]).slice(0, 400);
    if (!/^https?:\/\//.test(url) || !title) continue;
    results.push({ title, url, snippet: snip });
  }
  if (results.length === 0) throw new Error("no results parsed");
  if (looksLikeJunk(results, ctx.query)) {
    throw new Error("bot junk detected (results unrelated to query)");
  }
  return results;
}

async function engineBrave(ctx) {
  const p = new URLSearchParams({ q: ctx.query, count: String(Math.min(ctx.n, 20)) });
  if (ctx.lang === "zh") { p.set("country", "cn"); p.set("search_lang", "zh-hans"); }
  const { status, body } = await fetchText(`https://api.search.brave.com/res/v1/web/search?${p}`, {
    headers: { accept: "application/json", "x-subscription-token": process.env.BRAVE_API_KEY },
    timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.web?.results || [];
  return items.map((r) => ({ title: r.title, url: r.url, snippet: r.description || "" }));
}

async function engineTavily(ctx) {
  const payload = { api_key: process.env.TAVILY_API_KEY, query: ctx.query, max_results: Math.min(ctx.n, 20) };
  const { status, body } = await fetchText("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.results || [];
  return items.map((r) => ({ title: r.title || r.url, url: r.url, snippet: (r.content || "").slice(0, 400) }));
}

async function engineSerper(ctx) {
  const payload = { q: ctx.query, num: Math.min(ctx.n, 20) };
  if (ctx.lang === "zh") { payload.gl = "cn"; payload.hl = "zh-cn"; }
  const { status, body } = await fetchText("https://google.serper.dev/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.SERPER_API_KEY },
    body: JSON.stringify(payload),
    timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.organic || [];
  return items.map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || "" }));
}

async function engineExa(ctx) {
  const payload = { query: ctx.query, numResults: Math.min(ctx.n, 20) };
  if (ctx.days > 0) {
    const d = new Date(Date.now() - ctx.days * 86400000).toISOString().slice(0, 10);
    payload.startPublishedDate = d;
  }
  const { status, body } = await fetchText("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.EXA_API_KEY },
    body: JSON.stringify(payload),
    timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.results || [];
  return items.map((r) => ({ title: r.title || r.url, url: r.url, snippet: (r.text || r.summary || "").slice(0, 400) }));
}

async function engineAnysearch(ctx) {
  const payload = { query: ctx.query, max_results: Math.min(ctx.n, 20) };
  const headers = { "content-type": "application/json" };
  // Key optional — anonymous access works with lower rate limits.
  if (process.env.ANYSEARCH_API_KEY) headers["authorization"] = `Bearer ${process.env.ANYSEARCH_API_KEY}`;
  const { status, body } = await fetchText("https://api.anysearch.com/v1/search", {
    method: "POST", headers, body: JSON.stringify(payload), timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const res = parseJson(body);
  if (res.code !== 0) throw new Error(res.message || `code ${res.code}`);
  const items = res.data?.results || [];
  return items.map((r) => ({ title: r.title || r.url, url: r.url, snippet: (r.snippet || "").slice(0, 400) }));
}

async function engineKeenable(ctx) {
  const keyed = !!process.env.KEENABLE_API_KEY;
  const path = keyed ? "/v1/search" : "/v1/search/public";
  const payload = {
    query: ctx.query,
    max_results: Math.min(Math.max(ctx.n, 1), 50),
    snippet_max_length: 400,
  };
  const headers = { "content-type": "application/json" };
  if (keyed) headers["x-api-key"] = process.env.KEENABLE_API_KEY;
  else headers["x-keenable-title"] = "easy-websearch"; // required for keyless
  const { status, body } = await fetchText(`https://api.keenable.ai${path}`, {
    method: "POST", headers, body: JSON.stringify(payload), timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.results || [];
  return items
    .filter((r) => r.url && !r.url.startsWith("https://cards.keenable.ai/")) // ephemeral cards
    .map((r) => ({ title: r.title, url: r.url, snippet: (r.snippet || "").slice(0, 400) }));
}

async function engineFirecrawl(ctx) {
  const payload = {
    query: ctx.query,
    limit: Math.min(ctx.n, 20),
    scrapeOptions: { formats: ["markdown"] },
  };
  const { status, body } = await fetchText("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
    body: JSON.stringify(payload), timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const res = parseJson(body);
  if (res.success === false) throw new Error(res.error || "firecrawl error");
  const items = Array.isArray(res.data) ? res.data : res.data?.web || [];
  return items
    .filter((r) => r.url)
    .map((r) => ({ title: r.title || r.url, url: r.url, snippet: (r.description || r.markdown || "").slice(0, 400) }));
}

async function engineBocha(ctx) {
  // freshness: noLimit | oneDay | oneWeek | oneMonth | oneYear
  const d = ctx.days;
  const freshness = d <= 0 ? "noLimit" : d <= 1 ? "oneDay" : d <= 7 ? "oneWeek" : d <= 31 ? "oneMonth" : "oneYear";
  const payload = { query: ctx.query, freshness, summary: false, count: Math.min(Math.max(ctx.n, 1), 50) };
  const { status, body } = await fetchText("https://api.bochaai.com/v1/web-search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.BOCHA_API_KEY}` },
    body: JSON.stringify(payload), timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.data?.webPages?.value || [];
  return items
    .filter((r) => r.url)
    .map((r) => ({ title: r.name || r.url, url: r.url, snippet: (r.snippet || "").slice(0, 400) }));
}

async function engineMetaso(ctx) {
  const payload = {
    mode: "search",
    q: ctx.query,
    scope: "webpage",
    size: String(Math.min(Math.max(ctx.n, 1), 20)),
    includeSummary: false,
    conciseSnippet: true,
  };
  const { status, body } = await fetchText("https://metaso.cn/api/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.METASO_API_KEY}` },
    body: JSON.stringify(payload), timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const res = parseJson(body);
  // Metaso wraps errors in HTTP 200 (e.g. {"errCode":2005,"errMsg":"API密钥无效"}).
  if (res.errCode || res.error) throw new Error(res.errMsg || res.error || `errCode ${res.errCode}`);
  // Response envelope is not formally documented; walk the JSON for the
  // first array of URL-bearing objects (survives shape changes).
  const items = [];
  const visit = (v) => {
    if (!v || typeof v !== "object" || items.length >= 60) return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (typeof v.url === "string" && /^https?:\/\//.test(v.url)) { items.push(v); return; }
    Object.values(v).forEach(visit);
  };
  visit(res);
  return items
    .map((r) => ({ title: r.title || r.name || r.url, url: r.url, snippet: (r.snippet || r.summary || r.content || "").slice(0, 400) }));
}

async function engineLinkup(ctx) {
  const payload = { q: ctx.query, depth: "standard", outputType: "searchResults" };
  const { status, body } = await fetchText("https://api.linkup.so/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LINKUP_API_KEY}` },
    body: JSON.stringify(payload), timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.results || [];
  return items
    .filter((r) => r.url)
    .map((r) => ({ title: r.name || r.url, url: r.url, snippet: (r.content || "").slice(0, 400) }));
}

async function engineOllama(ctx) {
  const payload = { query: ctx.query };
  const { status, body } = await fetchText("https://ollama.com/api/web_search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OLLAMA_API_KEY}` },
    body: JSON.stringify(payload), timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.results || [];
  return items.slice(0, ctx.n)
    .filter((r) => r.url)
    .map((r) => ({ title: r.title || r.url, url: r.url, snippet: (r.content || "").slice(0, 400) }));
}

const ENGINES = {
  ddg: engineDDG,
  bing: engineBing,
  brave: { fn: engineBrave, key: "BRAVE_API_KEY" },
  tavily: { fn: engineTavily, key: "TAVILY_API_KEY" },
  serper: { fn: engineSerper, key: "SERPER_API_KEY" },
  exa: { fn: engineExa, key: "EXA_API_KEY" },
  firecrawl: { fn: engineFirecrawl, key: "FIRECRAWL_API_KEY" },
  bocha: { fn: engineBocha, key: "BOCHA_API_KEY" },
  metaso: { fn: engineMetaso, key: "METASO_API_KEY" },
  linkup: { fn: engineLinkup, key: "LINKUP_API_KEY" },
  ollama: { fn: engineOllama, key: "OLLAMA_API_KEY" },
  // Keyless backup engines: anonymous quotas are low, so they stay OFF by
  // default. Opt in via --engine or the EASY_WEB_SEARCH_ENGINES env var.
  anysearch: { fn: engineAnysearch, key: "ANYSEARCH_API_KEY", optionalKey: true, backup: true },
  keenable: { fn: engineKeenable, key: "KEENABLE_API_KEY", optionalKey: true, backup: true },
};

const BACKUP_ENGINES_ENV = "EASY_WEB_SEARCH_ENGINES";

function availableEngines(filter) {
  if (filter) {
    return filter.split(",").map((s) => s.trim()).filter((name) => !!ENGINES[name]);
  }
  const isAvailable = (name) => {
    const e = ENGINES[name];
    if (!e) return false;
    if (typeof e === "function") return true; // baseline
    if (e.key && !process.env[e.key] && !e.optionalKey) return false; // keyed, no key
    return true;
  };
  const engines = Object.keys(ENGINES).filter((name) => {
    const e = ENGINES[name];
    if (typeof e !== "object" || !e.backup) return isAvailable(name);
    return false; // backups excluded from the default set
  });
  // Opt-in backups via env (comma-separated), e.g. EASY_WEB_SEARCH_ENGINES=anysearch,keenable
  const optIn = (process.env[BACKUP_ENGINES_ENV] || "")
    .split(",").map((s) => s.trim()).filter((name) => ENGINES[name] && ENGINES[name].backup);
  for (const name of optIn) if (!engines.includes(name)) engines.push(name);
  return engines.filter(isAvailable);
}

// -------------------------------------------------------------- fusion ----
function fuse(engineResults) {
  const byUrl = new Map();
  for (const { name, results } of engineResults) {
    results.forEach((r, idx) => {
      const key = normalizeUrl(r.url);
      if (!byUrl.has(key)) byUrl.set(key, { ...r, url: r.url, score: 0, engines: [], ranks: [] });
      const item = byUrl.get(key);
      item.score += 1 / (RRF_K + idx + 1);
      item.engines.push(name);
      item.ranks.push(idx + 1);
      if (item.snippet.length < r.snippet.length) item.snippet = r.snippet;
    });
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------- cooldown ----
// Engines that just failed get a cooldown: default runs skip them (they
// would likely fail again and burn the request budget). Explicit --engine
// and --no-cooldown bypass the skip. State persists across invocations in
// the user's cache dir; IO failures degrade silently to no cooldown.
const COOLDOWN_MS = 10 * 60 * 1000;

function cooldownPath() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "easy-websearch", "cooldowns.json");
}

function loadCooldowns() {
  try {
    const state = JSON.parse(fs.readFileSync(cooldownPath(), "utf8"));
    return state && typeof state === "object" ? state : {};
  } catch { return {}; }
}

function saveCooldowns(state) {
  try {
    fs.mkdirSync(path.dirname(cooldownPath()), { recursive: true });
    fs.writeFileSync(cooldownPath(), JSON.stringify(state));
  } catch { /* best effort — cooldown is an optimization, not a guarantee */ }
}

// ---------------------------------------------------------------- main ----
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (!args.query) {
    console.error(`${USAGE}\nRun with --help for details.`);
    process.exit(2);
  }
  const ctx = { ...args, query: buildQuery(args) };
  if (args.engines) {
    const requested = args.engines.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = requested.filter((n) => !ENGINES[n]);
    if (unknown.length) {
      console.error(`Unknown engine(s): ${unknown.join(", ")}\nValid engines: ${Object.keys(ENGINES).join(", ")}`);
      process.exit(2);
    }
  }
  let engines = availableEngines(args.engines);
  if (engines.length === 0) {
    console.error("No search engines available (baseline ddg/bing need network; keyed engines need their env vars).\nValid engines: " + Object.keys(ENGINES).join(", "));
    process.exit(2);
  }

  // Skip engines in active cooldown (default selection only; explicit
  // --engine always wins). Never skip down to zero engines.
  const state = args.noCooldown ? {} : loadCooldowns();
  const now = Date.now();
  const inCooldown = engines.filter((n) => (state[n]?.until ?? 0) > now);
  const cooldownSkipped = [];
  if (!args.engines && inCooldown.length && inCooldown.length < engines.length) {
    for (const n of inCooldown) {
      cooldownSkipped.push({ name: n, ok: false, count: 0, ms: 0, error: `skipped (cooldown: ${state[n].reason || "recent failure"})` });
    }
    engines = engines.filter((n) => !inCooldown.includes(n));
  }

  const statuses = await Promise.all(
    engines.map(async (name) => {
      const t0 = Date.now();
      try {
        const e = ENGINES[name];
        const results = await (typeof e === "function" ? e : e.fn)(ctx);
        return { name, ok: true, count: results.length, ms: Date.now() - t0, results, error: "" };
      } catch (e) {
        return { name, ok: false, count: 0, ms: Date.now() - t0, results: [], error: e.message };
      }
    })
  );

  // Persist cooldown bookkeeping: successes clear, failures arm a cooldown.
  let dirty = false;
  for (const s of statuses) {
    if (s.ok) {
      if (state[s.name]) { delete state[s.name]; dirty = true; }
    } else if ((state[s.name]?.until ?? 0) < Date.now() + COOLDOWN_MS) {
      state[s.name] = { until: Date.now() + COOLDOWN_MS, reason: s.error.slice(0, 120) };
      dirty = true;
    }
  }
  if (dirty && !args.noCooldown) saveCooldowns(state);

  // --days is not supported by every engine — say so instead of silently
  // ignoring it.
  if (args.days > 0) {
    for (const s of statuses) {
      if (s.name === "bing" && s.ok) s.note = "days ignored by bing";
    }
  }

  const allEngines = [...cooldownSkipped, ...statuses];
  const fused = fuse(statuses.filter((s) => s.ok)).slice(0, args.n);

  if (args.json) {
    console.log(JSON.stringify({
      query: ctx.query,
      engines: allEngines.map(({ name, ok, count, ms, error, note }) => ({ name, ok, count, ms, error, ...(note ? { note } : {}) })),
      results: fused.map((r, i) => ({
        rank: i + 1, title: r.title, url: r.url, snippet: r.snippet,
        score: +r.score.toFixed(4), engines: r.engines,
      })),
    }, null, 2));
  } else {
    const engineLine = allEngines
      .map((s) => `${s.name}: ${s.ok ? s.count + " results" : s.count === 0 && s.ms === 0 && s.error.startsWith("skipped") ? s.error : "FAILED (" + s.error + ")"} in ${s.ms}ms${s.note ? ` [${s.note}]` : ""}`)
      .join("\n  ");
    console.log(`engines:\n  ${engineLine}\n`);
    if (fused.length === 0) {
      console.error("No results from any engine.");
      process.exit(1);
    }
    for (const [i, r] of fused.entries()) {
      console.log(`${i + 1}. ${r.title}`);
      console.log(`   ${r.url}`);
      if (r.snippet) console.log(`   ${r.snippet.slice(0, 200)}`);
      console.log(`   [${r.engines.join(", ")}]`);
    }
  }
}

// Run only when invoked directly (doctor.mjs imports this module).
import { pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();

export { ENGINES, availableEngines, parseArgs, buildQuery, looksLikeJunk, cooldownPath };
