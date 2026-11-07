#!/usr/bin/env node
/**
 * easy-web-search — multi-engine web search with RRF fusion and graceful degradation.
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
 *
 * Reliability-first: each engine runs independently with its own timeout;
 * failures never abort the run. Output reports per-engine status.
 */
import http from "node:http";
import https from "node:https";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DEFAULT_TIMEOUT = 8000;
const RRF_K = 60;

// ---------------------------------------------------------------- args ----
function parseArgs(argv) {
  const args = {
    query: "", n: 10, days: 0, site: [], excludeSite: [], lang: "",
    engines: "", timeout: DEFAULT_TIMEOUT, json: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-n" || a === "--num") args.n = parseInt(argv[++i], 10) || 10;
    else if (a === "--days") args.days = parseInt(argv[++i], 10) || 0;
    else if (a === "--site") args.site.push(argv[++i]);
    else if (a === "--exclude-site") args.excludeSite.push(argv[++i]);
    else if (a === "--lang") args.lang = argv[++i];
    else if (a === "--engine") args.engines = argv[++i];
    else if (a === "--timeout") args.timeout = (parseInt(argv[++i], 10) || 8) * 1000;
    else if (a === "--json") args.json = true;
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
    const pu = new URL(proxyUrl);
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

function fetchText(url, { method = "GET", headers = {}, body, timeout = DEFAULT_TIMEOUT } = {}) {
  const u = new URL(url);
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
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => finish(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }
  });
}

// ------------------------------------------------------------ helpers ----
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'" };
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

async function engineBing(ctx) {
  const params = new URLSearchParams({ q: ctx.query });
  if (ctx.lang === "zh") { params.set("mkt", "zh-CN"); params.set("setlang", "zh"); }
  else if (ctx.lang === "en") { params.set("mkt", "en-US"); params.set("setlang", "en"); }
  const { status, body } = await fetchText(`https://www.bing.com/search?${params}`, { timeout: ctx.timeout });
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
  const items = JSON.parse(body)?.web?.results || [];
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
  const items = JSON.parse(body)?.results || [];
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
  const items = JSON.parse(body)?.organic || [];
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
  const items = JSON.parse(body)?.results || [];
  return items.map((r) => ({ title: r.title || r.url, url: r.url, snippet: (r.text || r.summary || "").slice(0, 400) }));
}

const ENGINES = {
  ddg: engineDDG,
  bing: engineBing,
  brave: { fn: engineBrave, key: "BRAVE_API_KEY" },
  tavily: { fn: engineTavily, key: "TAVILY_API_KEY" },
  serper: { fn: engineSerper, key: "SERPER_API_KEY" },
  exa: { fn: engineExa, key: "EXA_API_KEY" },
};

function availableEngines(filter) {
  const names = filter
    ? filter.split(",").map((s) => s.trim()).filter(Boolean)
    : Object.keys(ENGINES);
  return names.filter((name) => {
    const e = ENGINES[name];
    if (!e) return false;
    if (typeof e === "function") return true; // baseline
    return !!process.env[e.key];
  });
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

// ---------------------------------------------------------------- main ----
const args = parseArgs(process.argv.slice(2));
if (!args.query) {
  console.error('Usage: node search.mjs "query" [-n 10] [--days 7] [--site d] [--exclude-site d] [--lang zh] [--engine ddg,bing] [--json]');
  process.exit(2);
}
const ctx = { ...args, query: buildQuery(args) };
const engines = availableEngines(args.engines);
if (engines.length === 0) {
  console.error("No search engines available. Baseline ddg/bing need network; keyed engines need their env vars.");
  process.exit(2);
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

const fused = fuse(statuses.filter((s) => s.ok)).slice(0, args.n);

if (args.json) {
  console.log(JSON.stringify({
    query: ctx.query,
    engines: statuses.map(({ name, ok, count, ms, error }) => ({ name, ok, count, ms, error })),
    results: fused.map((r, i) => ({
      rank: i + 1, title: r.title, url: r.url, snippet: r.snippet,
      score: +r.score.toFixed(4), engines: r.engines,
    })),
  }, null, 2));
} else {
  const engineLine = statuses
    .map((s) => `${s.name}: ${s.ok ? s.count + " results" : "FAILED (" + s.error + ")"} in ${s.ms}ms`)
    .join("\n  ");
  console.error(`engines:\n  ${engineLine}\n`);
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
