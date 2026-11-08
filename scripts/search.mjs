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

// ------------------------------------------------------------ config ----
// ~/.config/easy-websearch/config.json — defaults for CLI flags.
// CLI flags override config values. Env vars still override config for keys.
function loadConfig() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const p = path.join(base, "easy-websearch", "config.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

// ---------------------------------------------------------------- args ----
const USAGE = 'Usage: node search.mjs "query" [-n 10] [--days 7] [--site d] [--exclude-site d] [--lang zh] [--engine ddg,bing] [--timeout 8] [--no-cooldown] [--direct] [--json]';

const VALUE_FLAGS = new Set(["-n", "--num", "--days", "--site", "--exclude-site", "--lang", "--engine", "--timeout"]);
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, "--json", "--no-cooldown", "--direct", "--help", "-h"]);

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
  --direct                bypass any proxy for all engines (see README Troubleshooting)
  --json                  machine-readable output
  -h, --help              show this help
See README.md for details. Config: ~/.config/easy-websearch/config.json\nRun scripts/doctor.mjs to check engine health.`);
}

function parseArgs(argv) {
  const config = loadConfig();
  const args = {
    query: "", n: config.n || 10, days: config.days || 0, site: [], excludeSite: [], lang: config.lang || "",
    engines: config.engines || "", timeout: (config.timeout || 8) * 1000, json: false, noCooldown: false,
    direct: false, help: false,
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
    else if (a === "--direct") args.direct = true;
    else rest.push(a);
  }
  args.query = rest.join(" ").trim();
  return args;
}

// ------------------------------------------------------ cookie jar ----
// Minimal per-host cookie store: search responses often set cookies that
// subsequent requests need (e.g. Sogou /link redirects require SNUID), and
// keeping them also makes clients look more browser-like to anti-bot layers.
const cookieJar = new Map(); // host -> Map(name -> value)

function storeCookies(host, setCookies) {
  if (!setCookies) return;
  if (!cookieJar.has(host)) cookieJar.set(host, new Map());
  const jar = cookieJar.get(host);
  for (const sc of [].concat(setCookies)) {
    const pair = sc.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(host) {
  const jar = cookieJar.get(host);
  if (!jar || !jar.size) return "";
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
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

let FORCE_DIRECT = false; // set by main() from --direct / EASY_WEB_SEARCH_DIRECT
function setForceDirect(v = true) { FORCE_DIRECT = v; }

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
    const outgoing = { ...headers };
    const jarCookie = cookieHeader(u.hostname);
    if (jarCookie && !outgoing.cookie) outgoing.cookie = jarCookie;
    const opts = {
      method,
      headers: {
        "user-agent": UA,
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        ...outgoing,
      },
    };
    if (proxy && isHttps && !FORCE_DIRECT) {
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
      storeCookies(u.hostname, res.headers["set-cookie"]);
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
      res.on("end", () => finish(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), finalUrl: url }));
    }
  });
}

// ─────────────────────────────── retry with backoff ──
// Retry transient failures (timeout, 403, 429, 5xx) with exponential backoff.
// Only for GET requests (idempotent). 1 retry, 500ms delay.
const RETRYABLE = new Set(["timeout", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND"]);

function isRetryable(err) {
  if (err.message === "timeout") return true;
  if (/HTTP [45]\d\d/.test(err.message)) return true;
  for (const code of RETRYABLE) if (err.message.includes(code)) return true;
  return false;
}

async function retryFetch(url, opts = {}, depth = 0) {
  try {
    return await fetchText(url, opts, depth);
  } catch (err) {
    if (!isRetryable(err) || opts.method === "POST" || depth >= 1) throw err;
    await new Promise((r) => setTimeout(r, 500));
    return retryFetch(url, opts, depth + 1);
  }
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
    for (const k of [...x.searchParams.keys()]) {
      if (/^(utm_|ref|fbclid)/i.test(k)) x.searchParams.delete(k);
    }
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

// DDG serves the same HTML UI from several hosts. Anti-bot blocks are
// per-host, so rotate endpoints before failing (and arming a cooldown):
// html.duckduckgo.com → duckduckgo.com/html → lite (a separate table UI).
function ddgParams(ctx) {
  const params = new URLSearchParams({ q: ctx.query, nost: "1" });
  if (ctx.lang === "zh") params.set("kl", "cn-zh");
  else if (ctx.lang === "en") params.set("kl", "us-en");
  if (ctx.days > 0) params.set("df", ctx.days <= 1 ? "d" : ctx.days <= 7 ? "w" : "m");
  return params;
}

// Shared target extraction: html/lite UIs wrap results in /l/?uddg=<enc>.
function ddgPushResult(results, href, rawTitle) {
  const ud = href.match(/[?&]uddg=([^&]+)/);
  if (ud) href = decodeURIComponent(ud[1]);
  const title = stripTags(rawTitle);
  if (!title || !/^https?:\/\//.test(href)) return; // anomaly/challenge page guard
  results.push({ title, url: href, snippet: "" });
}

function parseDdgHtml(ctx, body) {
  const results = [];
  // Anchors: <a rel="nofollow" class="result__a" href="...">Title</a>, snippets follow.
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of body.matchAll(re)) {
    if (results.length >= ctx.n * 2) break;
    ddgPushResult(results, decodeEntities(m[1]), m[2]);
  }
  // Snippets appear after each anchor in document order.
  const snRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let i = 0;
  for (const s of body.matchAll(snRe)) {
    if (i >= results.length) break;
    results[i++].snippet = stripTags(s[1]);
  }
  if (results.length === 0 && /anomaly|challenge|captcha/i.test(body)) throw new Error("blocked (anomaly page)");
  if (results.length === 0) throw new Error("no results parsed");
  return results;
}

function parseDdgLite(ctx, body) {
  const results = [];
  // lite UI is table-based; attributes use single quotes and href precedes
  // the class: <a rel="nofollow" href="..." class='result-link'>Title</a>.
  const re = /<a\b([^>]*result-link[^>]*)>([\s\S]*?)<\/a>/g;
  for (const m of body.matchAll(re)) {
    if (results.length >= ctx.n * 2) break;
    const href = (m[1].match(/href="([^"]+)"/) || m[1].match(/href='([^']+)'/) || [])[1] || "";
    ddgPushResult(results, decodeEntities(href), m[2]);
  }
  const snRe = /<td\b[^>]*result-snippet[^>]*>([\s\S]*?)<\/td>/g;
  let i = 0;
  for (const s of body.matchAll(snRe)) {
    if (i >= results.length) break;
    results[i++].snippet = stripTags(s[1]);
  }
  if (results.length === 0 && /anomaly|challenge|captcha/i.test(body)) throw new Error("blocked (anomaly page)");
  if (results.length === 0) throw new Error("no results parsed");
  return results;
}

const DDG_ENDPOINTS = [
  { url: "https://html.duckduckgo.com/html/", parse: parseDdgHtml },
  { url: "https://duckduckgo.com/html/", parse: parseDdgHtml },
  { url: "https://lite.duckduckgo.com/lite/?", parse: parseDdgLite },
];

async function engineDDG(ctx) {
  const params = ddgParams(ctx);
  let lastErr;
  for (const ep of DDG_ENDPOINTS) {
    try {
      let status, body;
      if (ep.parse === parseDdgLite) {
        // lite serves a GET form; the html UIs take a POST form.
        ({ status, body } = await fetchText(ep.url + params.toString(), { timeout: ctx.timeout }));
      } else {
        ({ status, body } = await fetchText(ep.url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          timeout: ctx.timeout,
        }));
      }
      if (status !== 200) throw new Error(`HTTP ${status}`);
      return ep.parse(ctx, body);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
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
      const hay = `${r.title} ${r.url} ${r.snippet}`.toLowerCase();
      return words.some((w) => hay.includes(w));
    });
    if (!anyHit) return true;
  }
  return false;
}

// Bing serves the same b_algo SERP markup from regional hosts. Blocks and
// bot-junk pages are per-host, so rotate before failing (and arming a
// cooldown): www → cn (CN-tuned, looser for CN queries) → global; an
// all-HTML failure falls through to the RSS pipeline (format=rss).
const BING_HOSTS = ["https://www.bing.com", "https://cn.bing.com", "https://global.bing.com"];

function parseBingResults(ctx, body) {
  const results = [];
  const liRe = /<li class="b_algo"[\s\S]*?<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)<\/li>/g;
  for (const m of body.matchAll(liRe)) {
    if (results.length >= ctx.n * 2) break;
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

async function engineBing(ctx) {
  const params = new URLSearchParams({ q: ctx.query });
  if (ctx.lang === "zh") { params.set("mkt", "zh-CN"); params.set("setlang", "zh"); }
  else if (ctx.lang === "en") { params.set("mkt", "en-US"); params.set("setlang", "en"); }
  let lastErr;
  for (const host of BING_HOSTS) {
    try {
      const { status, body } = await retryFetch(`${host}/search?${params}`, {
        timeout: ctx.timeout,
        headers: { referer: `${host}/`, "upgrade-insecure-requests": "1" },
      });
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const results = parseBingResults(ctx, body);
      if (looksLikeJunk(results, ctx.query)) {
        throw new Error("bot junk detected (results unrelated to query)");
      }
      return results;
    } catch (e) { lastErr = e; }
  }
  // All HTML hosts failed — try the RSS pipeline as the last variant.
  try {
    const { status, body } = await retryFetch(`https://www.bing.com/search?${params}&format=rss`, {
      timeout: ctx.timeout,
      headers: { referer: "https://www.bing.com/", "upgrade-insecure-requests": "1" },
    });
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return parseBingRss(ctx, body);
  } catch (e) { lastErr = e; }
  throw lastErr;
}

// RSS fallback: format=rss serves structured XML from a different content
// pipeline — HTML bot-junk pages don't affect it, and it tolerates bots best.
function parseBingRss(ctx, body) {
  const results = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  for (const m of body.matchAll(itemRe)) {
    if (results.length >= ctx.n * 2) break;
    const item = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    const title = stripTags((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const link = (item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
    const desc = (item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "";
    if (!/^https?:\/\//.test(link) || !title) continue;
    results.push({ title, url: decodeEntities(link), snippet: stripTags(desc).slice(0, 400) });
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

// Follow a redirect chain (baidu /link etc.) and return the final URL.
// Baidu's /link is flaky (403 on first hit, 200 on retry) — require 200,
// retry once.
async function resolveRedirect(url, timeout) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchText(url, { timeout: Math.min(timeout, 5000) });
      if (r.status === 200 && r.finalUrl && /^https?:\/\//.test(r.finalUrl) &&
          !/baidu\.com\/link/.test(r.finalUrl)) {
        return r.finalUrl;
      }
    } catch { /* retry / keep the original URL */ }
  }
  return url;
}

// Baidu WAF state is per-host. Desktop www first; the mobile SERP
// (m.baidu.com, `word` param) sits behind a looser WAF and serves as the
// fallback. The <h3><a> markup is shared by both UIs.
const BAIDU_VARIANTS = [
  (q, rn) => ({ url: `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=${rn}`, referer: "https://www.baidu.com/" }),
  (q, rn) => ({ url: `https://m.baidu.com/s?word=${encodeURIComponent(q)}&rn=${rn}`, referer: "https://www.baidu.com/" }),
];

function parseBaiduResults(ctx, body) {
  const results = [];
  const re = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of body.matchAll(re)) {
    if (results.length >= ctx.n * 2) break;
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(m[1])) continue;
    results.push({ title, url: decodeEntities(m[1]), snippet: "" });
  }
  if (results.length === 0) throw new Error("no results parsed");
  return results;
}

async function engineBaidu(ctx) {
  const rn = String(Math.min(Math.max(ctx.n, 1), 20));
  let lastErr;
  for (const variant of BAIDU_VARIANTS) {
    const { url, referer } = variant(ctx.query, rn);
    try {
      const { status, body } = await retryFetch(url, {
        timeout: ctx.timeout,
        headers: { referer },
      });
      if (status !== 200) throw new Error(`HTTP ${status}`);
      if (body.includes("百度安全验证") || body.includes("wappass")) {
        throw new Error("baidu anti-bot page (security verification)");
      }
      const results = parseBaiduResults(ctx, body);
      if (looksLikeJunk(results, ctx.query)) {
        throw new Error("bot junk detected (results unrelated to query)");
      }
      // Resolve baidu /link redirect wrappers to real targets (fusion dedup
      // needs canonical URLs).
      const tops = results.slice(0, ctx.n);
      const resolved = await Promise.all(tops.map((r) => resolveRedirect(r.url, ctx.timeout)));
      tops.forEach((r, i) => { r.url = resolved[i]; });
      return tops;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Sogou WeChat /link redirects return a JS stub; the real target is embedded
// in it. Resolve up to a few links in parallel; failures keep the /link URL.
async function resolveSogouLinks(urls, timeout, base = "https://weixin.sogou.com") {
  return Promise.all(urls.map(async (u) => {
    if (!u.startsWith("/link")) return u;
    try {
      const full = new URL(u, base).toString();
      const { body } = await fetchText(full, { timeout: Math.min(timeout, 4000) });
      // Stub looks like:  url += 'https://mp.';  url += 'weixin.qq.c';  …
      // Capture group excludes the quotes; concat the pieces directly.
      let target = "";
      for (const m of body.matchAll(/url\s*\+=\s*'([^']*)'/g)) target += m[1];
      target = target.replace(/@.*$/, "");
      if (/^https?:\/\//.test(target)) return target;
      const alt = body.match(/window\.location\.replace\("([^"]+)"\)/);
      if (alt && /^https?:\/\//.test(alt[1])) return alt[1];
    } catch { /* keep the /link URL */ }
    return u;
  }));
}

// Extract a text snippet from the body right after a result anchor's match.
function snippetAfter(body, from, len = 200) {
  const chunk = body.slice(from, from + 700);
  const text = stripTags(chunk);
  return text.slice(0, len);
}

// so.com/link?m= pages redirect via window.location.replace("target").
function resolveSo360Links(urls, timeout) {
  return Promise.all(urls.map(async (u) => {
    if (!/so\.com\/link/.test(u)) return u;
    try {
      const { body } = await fetchText(u, { timeout: Math.min(timeout, 4000) });
      const m = body.match(/window\.location\.replace\("([^"]+)"\)/) ||
                body.match(/window\.location\.href\s*=\s*"([^"]+)"/) ||
                body.match(/URL='([^']+)'/);
      if (m && /^https?:\/\//.test(m[1])) return m[1];
    } catch { /* keep the wrapper URL */ }
    return u;
  }));
}

async function engineSogouWeb(ctx) {
  const params = new URLSearchParams({ query: ctx.query });
  const { status, body } = await retryFetch("https://www.sogou.com/web?" + params.toString(), {
    timeout: ctx.timeout,
    headers: { referer: "https://www.sogou.com/" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (/antispider|验证码|seccode/i.test(body)) {
    throw new Error("sogou anti-bot page (captcha) — retry later");
  }
  const results = [];
  const re = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of body.matchAll(re)) {
    if (results.length >= ctx.n * 2) break;
    const title = stripTags(m[2]);
    if (!title) continue;
    results.push({ title, url: decodeEntities(m[1]), snippet: snippetAfter(body, m.index + m[0].length) });
  }
  if (results.length === 0) throw new Error("no results parsed");
  const tops = results.slice(0, ctx.n);
  const urls = await resolveSogouLinks(tops.map((r) => r.url), ctx.timeout, "https://www.sogou.com");
  tops.forEach((r, i) => { r.url = urls[i]; });
  return tops;
}

// WAF state is per-host: desktop www first, then the mobile SERP behind a
// looser mobile gate (same res-title titles, but links are jump?u=<enc>
// wrappers on anchors preceding each title, not /link redirects).
function parseSo360Desktop(ctx, body) {
  const results = [];
  const re = /<h3[^>]*class="res-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of body.matchAll(re)) {
    if (results.length >= ctx.n * 2) break;
    const title = stripTags(m[2]);
    if (!title) continue;
    const desc = body.slice(m.index, m.index + 900).match(/<p class="res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    results.push({ title, url: decodeEntities(m[1]), snippet: desc ? stripTags(desc[1]).slice(0, 300) : "" });
  }
  if (results.length === 0) throw new Error("no results parsed");
  return results;
}

function parseSo360Mobile(ctx, body) {
  const results = [];
  const re = /<h3 class="res-title">([\s\S]*?)<\/h3>/g;
  for (const m of body.matchAll(re)) {
    if (results.length >= ctx.n * 2) break;
    const title = stripTags(m[1]);
    if (!title) continue;
    // Result URL: the closest jump?u=<enc> wrapper before the title (layout
    // varies by card type; the anchor always precedes the <h3>).
    const before = body.slice(Math.max(0, m.index - 800), m.index);
    const links = [...before.matchAll(/jump\?u=([^"'&\s]+)/g)];
    if (!links.length) continue;
    const url = decodeURIComponent(links[links.length - 1][1]);
    if (!/^https?:\/\//.test(url)) continue;
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 600);
    const sm = after.match(/<p class="g-main summary">([\s\S]*?)<\/p>/);
    results.push({ title, url, snippet: sm ? stripTags(sm[1]).slice(0, 300) : "" });
  }
  if (results.length === 0) throw new Error("no results parsed");
  return results;
}

const SO360_VARIANTS = [
  { url: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}`, referer: "https://www.so.com/", parse: parseSo360Desktop },
  { url: (q) => `https://m.so.com/s?q=${encodeURIComponent(q)}`, referer: "https://m.so.com/", parse: parseSo360Mobile },
];

async function engineSo360(ctx) {
  let lastErr;
  for (const variant of SO360_VARIANTS) {
    const { url: buildUrl, referer, parse } = variant;
    try {
      const { status, body } = await fetchText(buildUrl(ctx.query), {
        timeout: ctx.timeout,
        headers: { referer },
      });
      if (status !== 200) throw new Error(`HTTP ${status}`);
      if (/验证码|wappass/i.test(body)) {
        throw new Error("so360 anti-bot page (captcha) — retry later");
      }
      const results = parse(ctx, body);
      const tops = results.slice(0, ctx.n);
      const urls = await resolveSo360Links(tops.map((r) => r.url), ctx.timeout);
      tops.forEach((r, i) => { r.url = urls[i]; });
      return tops;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function engineSogouWeixin(ctx) {
  const params = new URLSearchParams({ type: "2", query: ctx.query });
  const { status, body } = await fetchText("https://weixin.sogou.com/weixin?" + params.toString(), {
    timeout: ctx.timeout,
    headers: { referer: "https://weixin.sogou.com/" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (/antispider|验证码|seccode/i.test(body)) {
    throw new Error("sogou anti-bot page (captcha) — retry later");
  }
  const results = [];
  const re = /<h3>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of body.matchAll(re)) {
    if (results.length >= ctx.n * 2) break;
    const title = stripTags(m[2]);
    if (!title) continue;
    results.push({ title, url: decodeEntities(m[1]), snippet: "" });
  }
  if (results.length === 0) throw new Error("no results parsed");
  const urls = await resolveSogouLinks(results.slice(0, ctx.n).map((r) => r.url), ctx.timeout);
  results.slice(0, ctx.n).forEach((r, i) => { r.url = urls[i]; });
  return results.slice(0, ctx.n);
}

// Split SEARXNG_BASE_URL into (clean base, optional basic-auth header).
// Supports https://user:pass@host:port forms (needed when the instance sits
// behind a reverse proxy with basic auth).
function searxngBaseAndAuth(raw) {
  const base = (raw || "").replace(/\/$/, "");
  const ui = base.match(/^(https?:\/\/)([^@\/]*)@(.*)$/);
  if (!ui) return { base, authorization: "" };
  const authorization = "Basic " + Buffer.from(decodeURIComponent(ui[2])).toString("base64");
  return { base: ui[1] + ui[3], authorization };
}

// ── Vertical engines (official keyless APIs) — auto-activated by query intent ──

async function engineWikipedia(ctx) {
  const cjk = /[\u4e00-\u9fa5]/.test(ctx.query);
  const lang = ["zh", "en"].includes(ctx.lang) ? ctx.lang : cjk ? "zh" : "en";
  const params = new URLSearchParams({
    action: "query", list: "search", srsearch: ctx.query,
    format: "json", srlimit: String(Math.min(ctx.n, 10)),
  });
  // Wikipedia via slow proxies sits right at the generic timeout — give it 1.5×.
  const wikiTimeout = Math.max(ctx.timeout * 1.5, 12000);
  const { status, body } = await retryFetch(`https://${lang}.wikipedia.org/w/api.php?${params}`, {
    timeout: wikiTimeout, headers: { accept: "application/json" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.query?.search || [];
  return items.map((r) => ({
    title: r.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, "_"))}`,
    snippet: stripTags(r.snippet || ""),
  }));
}

async function engineStackExchange(ctx) {
  const params = new URLSearchParams({
    intitle: ctx.query, site: "stackoverflow",
    pagesize: String(Math.min(ctx.n, 10)),
  });
  const { status, body } = await retryFetch(`https://api.stackexchange.com/2.3/search/excerpts?${params}`, {
    timeout: ctx.timeout, headers: { accept: "application/json" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.items || [];
  return items
    .filter((r) => r.question_id && r.title)
    .map((r) => ({
      title: stripTags(r.title),
      url: `https://stackoverflow.com/q/${r.question_id}`,
      snippet: stripTags(r.excerpt || "").slice(0, 300),
    }));
}

async function engineHn(ctx) {
  const params = new URLSearchParams({ query: ctx.query, hitsPerPage: String(Math.min(ctx.n, 10)) });
  const { status, body } = await retryFetch(`https://hn.algolia.com/api/v1/search?${params}`, {
    timeout: ctx.timeout, headers: { accept: "application/json" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const hits = parseJson(body)?.hits || [];
  return hits
    .filter((r) => r.title)
    .map((r) => ({
      title: r.title,
      url: r.url || `https://news.ycombinator.com/item?id=${r.objectID}`,
      snippet: stripTags(r.story_text || r.comment_text || "").slice(0, 300),
    }));
}

async function engineGithub(ctx) {
  const params = new URLSearchParams({ q: ctx.query, per_page: String(Math.min(ctx.n, 10)) });
  const { status, body } = await retryFetch(`https://api.github.com/search/repositories?${params}`, {
    timeout: ctx.timeout,
    headers: { accept: "application/vnd.github+json" },
  });
  if (status === 403) throw new Error("GitHub rate limit (10 searches/min unauthenticated) — cooldown covers");
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.items || [];
  return items.map((r) => ({
    title: `${r.full_name} ⭐${r.stargazers_count ?? 0}`,
    url: r.html_url,
    snippet: (r.description || "").slice(0, 300),
  }));
}

async function engineJuejin(ctx) {
  const params = new URLSearchParams({ query: ctx.query, id_type: "0", cursor: "0", limit: String(Math.min(ctx.n, 10)) });
  const { status, body } = await fetchText(`https://api.juejin.cn/search_api/v1/search?${params}`, {
    timeout: ctx.timeout, headers: { accept: "application/json" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const d = parseJson(body);
  if (d.err_no !== 0) throw new Error(d.err_msg || `err_no ${d.err_no}`);
  const out = [];
  for (const item of d.data || []) {
    const info = item.result_model?.article_info;
    if (!info?.title) continue;
    out.push({
      title: info.title,
      url: `https://juejin.cn/post/${item.result_model.article_id}`,
      snippet: (info.brief_content || "").slice(0, 300),
    });
    if (out.length >= ctx.n) break;
  }
  return out;
}

async function engineArxiv(ctx) {
  const params = new URLSearchParams({
    search_query: `all:${ctx.query}`,
    max_results: String(Math.min(ctx.n, 10)),
  });
  const { status, body } = await fetchText(`http://export.arxiv.org/api/query?${params}`, {
    timeout: ctx.timeout,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const out = [];
  for (const m of body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const title = stripTags((entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const id = (entry.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || "";
    const summary = stripTags((entry.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "");
    if (!title || !id.startsWith("http")) continue;
    out.push({ title, url: id.replace("http://", "https://"), snippet: summary.slice(0, 300) });
  }
  return out;
}

async function engineMwmbl(ctx) {
  const { status, body } = await retryFetch(`https://api.mwmbl.org/api/v1/search/?s=${encodeURIComponent(ctx.query)}`, {
    timeout: ctx.timeout, headers: { accept: "application/json" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body) || [];
  return items.slice(0, ctx.n)
    .filter((r) => r.url)
    .map((r) => ({
      title: (r.title || []).map((f) => f.value).join("") || r.url,
      url: r.url,
      snippet: (r.extract || []).map((f) => f.value).join("").slice(0, 300),
    }));
}

// ── Academic / registry engines (official keyless APIs) — auto tier ──

async function engineCSDN(ctx) {
  const params = new URLSearchParams({ q: ctx.query, t: "blog", p: "1" });
  const { status, body } = await fetchText(`https://so.csdn.net/api/v3/search?${params}`, {
    timeout: ctx.timeout,
    headers: { accept: "application/json", referer: "https://www.csdn.net/" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.result_vos || [];
  return items.slice(0, ctx.n)
    .filter((r) => r.url && r.title)
    .map((r) => ({
      title: stripTags(r.title),
      url: r.url,
      snippet: stripTags(r.description || "").slice(0, 300),
    }));
}

async function engineOpenAlex(ctx) {
  const params = new URLSearchParams({ search: ctx.query, "per-page": String(Math.min(ctx.n, 10)) });
  const { status, body } = await retryFetch(`https://api.openalex.org/works?${params}`, {
    timeout: ctx.timeout, headers: { accept: "application/json" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.results || [];
  return items.map((r) => {
    const doiLink = r.doi ? `https://doi.org/${String(r.doi).replace(/^https?:\/\/doi\.org\//, "")}` : String(r.id || "");
    const venue = r.primary_location?.source?.display_name || "";
    return {
      title: r.display_name || doiLink,
      url: doiLink,
      snippet: [r.publication_year, venue].filter(Boolean).join(" · "),
    };
  }).filter((r) => r.url.startsWith("http"));
}

async function engineCrossref(ctx) {
  const params = new URLSearchParams({ query: ctx.query, rows: String(Math.min(ctx.n, 10)) });
  const { status, body } = await retryFetch(`https://api.crossref.org/works?${params}`, {
    timeout: ctx.timeout, headers: { accept: "application/json" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.message?.items || [];
  return items.map((r) => {
    const title = (r.title || [])[0] || "";
    const url = r.URL || (r.DOI ? `https://doi.org/${r.DOI}` : "");
    const venue = (r["container-title"] || [])[0] || r.publisher || "";
    const year = ((r.issued || {})["date-parts"] || [[]])[0][0] || "";
    return { title, url, snippet: [year, venue].filter(Boolean).join(" · ") };
  }).filter((r) => r.url && r.title);
}

async function enginePubMed(ctx) {
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  const headers = { accept: "application/json" };
  const sparams = new URLSearchParams({ db: "pubmed", term: ctx.query, retmode: "json", retmax: String(Math.min(ctx.n, 10)) });
  const s1 = await fetchText(`${base}/esearch.fcgi?${sparams}`, { timeout: ctx.timeout, headers });
  if (s1.status !== 200) throw new Error(`esearch HTTP ${s1.status}`);
  const ids = parseJson(s1.body)?.esearchresult?.idlist || [];
  if (ids.length === 0) return [];
  const sparams2 = new URLSearchParams({ db: "pubmed", id: ids.join(","), retmode: "json" });
  const s2 = await fetchText(`${base}/esummary.fcgi?${sparams2}`, { timeout: ctx.timeout, headers });
  if (s2.status !== 200) throw new Error(`esummary HTTP ${s2.status}`);
  const res = parseJson(s2.body)?.result || {};
  return (res.uids || []).map((uid) => {
    const doc = res[uid] || {};
    return {
      title: stripTags(doc.title || ""),
      url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
      snippet: [doc.pubdate, doc.source].filter(Boolean).join(" · "),
    };
  });
}

async function engineHuggingFace(ctx) {
  const params = new URLSearchParams({ search: ctx.query, limit: String(Math.min(ctx.n, 10)) });
  const { status, body } = await retryFetch(`https://huggingface.co/api/models?${params}`, {
    timeout: ctx.timeout, headers: { accept: "application/json" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body) || [];
  return items.slice(0, ctx.n).map((r) => ({
    title: r.id || r.modelId,
    url: `https://huggingface.co/${r.id}`,
    snippet: [r.pipeline_tag, `${r.downloads ?? 0} downloads`, `${r.likes ?? 0} likes`].filter(Boolean).join(" · "),
  }));
}

async function engineSearxng(ctx) {
  if (!process.env.SEARXNG_BASE_URL) {
    throw new Error("SEARXNG_BASE_URL not set — see README SearXNG section");
  }
  const { base, authorization } = searxngBaseAndAuth(process.env.SEARXNG_BASE_URL);
  const params = new URLSearchParams({ q: ctx.query, format: "json" });
  // HF 无中文界面: lang=zh 时仍用英文搜索(0 结果是 HF 侧现实)
  if (ctx.lang === "en") params.set("language", "en");
  else if (ctx.lang === "en") params.set("language", "en");
  const { status, body } = await fetchText(`${base}/search?${params.toString()}`, {
    timeout: ctx.timeout,
    headers: { accept: "application/json", ...(authorization && { authorization }) },
  });
  if (status === 403) {
    throw new Error("SearXNG rejected JSON — add 'json' to search.formats in settings.yml");
  }
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.results || [];
  return items.slice(0, ctx.n)
    .filter((r) => r.url)
    .map((r) => ({ title: r.title || r.url, url: r.url, snippet: (r.content || "").slice(0, 400) }));
}

const ENGINES = {
  ddg: engineDDG,
  bing: engineBing,
  baidu: engineBaidu,
  sogouweb: engineSogouWeb,
  so360: engineSo360,
  brave: { fn: engineBrave, key: "BRAVE_API_KEY" },
  tavily: { fn: engineTavily, key: "TAVILY_API_KEY" },
  serper: { fn: engineSerper, key: "SERPER_API_KEY" },
  exa: { fn: engineExa, key: "EXA_API_KEY" },
  firecrawl: { fn: engineFirecrawl, key: "FIRECRAWL_API_KEY" },
  bocha: { fn: engineBocha, key: "BOCHA_API_KEY" },
  metaso: { fn: engineMetaso, key: "METASO_API_KEY" },
  linkup: { fn: engineLinkup, key: "LINKUP_API_KEY" },
  ollama: { fn: engineOllama, key: "OLLAMA_API_KEY" },
  searxng: { fn: engineSearxng, key: "SEARXNG_BASE_URL" },
  // ── Vertical engines (official keyless APIs) — auto tier ──
  wikipedia: { fn: engineWikipedia, key: null },
  stackexchange: { fn: engineStackExchange, key: null, auto: true },
  github: { fn: engineGithub, key: null, auto: true },
  hn: { fn: engineHn, key: null },
  juejin: { fn: engineJuejin, key: null },
  arxiv: { fn: engineArxiv, key: null },
  mwmbl: { fn: engineMwmbl, key: null },
  // ── Academic / registry (official keyless APIs) — auto tier ──
  csdn: { fn: engineCSDN, key: null },
  openalex: { fn: engineOpenAlex, key: null },
  crossref: { fn: engineCrossref, key: null },
  pubmed: { fn: enginePubMed, key: null },
  huggingface: { fn: engineHuggingFace, key: null },
  // Keyless backup engines: anonymous quotas are low, so they stay OFF by
  // default. Opt in via --engine or the EASY_WEB_SEARCH_ENGINES env var.
  anysearch: { fn: engineAnysearch, key: "ANYSEARCH_API_KEY", optionalKey: true, backup: true },
  keenable: { fn: engineKeenable, key: "KEENABLE_API_KEY", optionalKey: true, backup: true },
  // Keyless vertical engine (WeChat articles only) — opt-in like backups.
  sogouweixin: { fn: engineSogouWeixin, key: null, backup: true },
};

const BACKUP_ENGINES_ENV = "EASY_WEB_SEARCH_ENGINES";

// Query-intent routing: auto tier engines join on strong signals only.
// Conservative patterns — false positives burn quota (github/stackexchange).
// Extract the longest ASCII keyword run — vertical engines index English.
function extractIntlQuery(query) {
  const runs = query.match(/[A-Za-z][A-Za-z0-9+#.\\/_ -]{2,}/g) || [];
  const cleaned = runs.map((r) => r.trim()).filter((r) => r.length >= 3);
  if (!cleaned.length) return query;
  return cleaned.sort((a, b) => b.length - a.length)[0];
}

function routeAuto(query) {
  const add = [];
  const q = query.toLowerCase();
  if (/(github|gitee|开源仓库|源码|repo\b|open[- ]?source)/.test(q)) add.push("github");
  if (/(stackoverflow|stack\s?exchange|报错|exception|traceback|怎么解决|how to (fix|debug))/.test(q)) add.push("stackexchange");
  if (/(论文|文献|arxiv|学术|research paper|preprint)/.test(q)) add.push("arxiv", "openalex", "crossref", "pubmed");
  if (/(什么是|百科|维基百科|wikipedia|是谁|who is|history of)/.test(q)) add.push("wikipedia");
  if (/(hacker\s?news|show\s?hn|tech news|科技新闻)/.test(q)) add.push("hn");
  if (/(掘金|juejin|csdn|前端开发|javascript 教程|vue\b|react\b)/.test(q)) add.push("juejin", "csdn");
  if (/(huggingface|数据集|dataset|模型权重|safetensors)/.test(q)) add.push("huggingface");
  return { engines: add, intlQuery: extractIntlQuery(query) };
}

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
    if (typeof e !== "object") return isAvailable(name);
    if (e.backup || e.auto) return false; // backups + auto tier excluded from default
    return isAvailable(name);
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
const COOLDOWN_MS_FIRST = 2 * 60 * 1000;  // transient network blips recover fast
const COOLDOWN_MS_MAX = 10 * 60 * 1000;   // repeat offenders stay longer

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
  FORCE_DIRECT = args.direct || process.env.EASY_WEB_SEARCH_DIRECT === "1";
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
  // Query-intent routing: auto tier joins only on strong signals (default
  // selection only; explicit --engine overrides the whole list anyway).
  if (!args.engines) {
    const routed = routeAuto(ctx.query);
    for (const n of routed.engines) {
      if (!engines.includes(n)) engines.push(n);
    }
    if (routed.engines.length) { ctx.intlQuery = routed.intlQuery; ctx.query = routed.intlQuery; }
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
    } else if ((state[s.name]?.until ?? 0) < Date.now() + COOLDOWN_MS_MAX) {
      // Escalating cooldown: first failure 2 min (transient blips), repeats 10 min.
      const failures = (state[s.name]?.failures || 0) + 1;
      const ms = failures === 1 ? COOLDOWN_MS_FIRST : COOLDOWN_MS_MAX;
      state[s.name] = { until: Date.now() + ms, reason: s.error.slice(0, 120), failures };
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

export { ENGINES, availableEngines, parseArgs, buildQuery, looksLikeJunk, cooldownPath, searxngBaseAndAuth, setForceDirect, routeAuto, extractIntlQuery, fetchText, stripTags, parseJson, normalizeUrl, fuse,
  // SERP parsers (tested against tests/snapshots/ in both runtimes)
  parseDdgHtml, parseDdgLite, parseBingResults, parseBingRss, parseBaiduResults, parseSo360Desktop, parseSo360Mobile };
