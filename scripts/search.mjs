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
import { buildExtraEngines } from "./extra-engines.mjs";
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
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, "--json", "--no-cooldown", "--direct", "--fast", "--help", "-h"]);

// What people actually type vs what the registry calls it.
const ENGINE_ALIASES = {
  duckduckgo: "ddg", ddg_html: "ddg", ddg_lite: "ddg",
  google: "serper", googlesearch: "serper", googlecse: "googlecse",
  sogou: "sogouweb", sogou_web: "sogouweb", "360": "so360", so: "so360",
  baidu_search: "baidu", bing_cn: "bing", bingcn: "bing",
  gh: "github", wiki: "wikipedia", wikipedia_zh: "wikipedia",
  arxiv_org: "arxiv", hf: "huggingface", huggface: "huggingface",
  semantischolar: "semanticscholar", s2: "semanticscholar",
  exa_mcp: "examcp", exa_mcp_free: "examcp", parallel_mcp: "parallelmcp",
  para: "parallel", context7_docs: "context7", deepwiki_mcp: "deepwiki",
  tavily_search: "tavily", brave_search: "brave", firecrawl_search: "firecrawl",
};

function resolveEngineName(raw) {
  const n = String(raw || "").trim().toLowerCase();
  if (ENGINES[n]) return n;
  if (ENGINE_ALIASES[n] && ENGINES[ENGINE_ALIASES[n]]) return ENGINE_ALIASES[n];
  return null;
}

// Cheap edit distance — only used to say "did you mean …".
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function suggestEngine(raw) {
  const n = String(raw || "").trim().toLowerCase();
  let best = null;
  let bestD = Infinity;
  for (const name of Object.keys(ENGINES)) {
    const d = editDistance(n, name);
    if (d < bestD) { bestD = d; best = name; }
  }
  return bestD <= Math.max(2, Math.floor(n.length / 3)) ? best : null;
}

function printHelp() {
  // Engine lists are derived from the registry, so --help can never advertise a
  // stale subset again.
  const names = Object.keys(ENGINES);
  const isFn = (n) => typeof ENGINES[n] === "function";
  const obj = (n) => (typeof ENGINES[n] === "object" ? ENGINES[n] : {});
  const baseline = names.filter((n) => isFn(n));
  const keylessDefault = names.filter((n) => !isFn(n) && !obj(n).auto && !obj(n).backup
    && (!obj(n).key || obj(n).optionalKey));
  const keylessAuto = names.filter((n) => !isFn(n) && obj(n).auto && (!obj(n).key || obj(n).optionalKey));
  const backup = names.filter((n) => !isFn(n) && obj(n).backup);
  const keyed = names.filter((n) => !isFn(n) && !obj(n).backup && obj(n).key && !obj(n).optionalKey);
  const wrap = (arr) => arr.join(", ");

  console.log(USAGE);
  console.log(`
Engines (${names.length} total):
  always on   ${wrap([...baseline, ...keylessDefault])}
  on intent   ${wrap(keylessAuto)}
  opt-in      ${wrap(backup)}   (--engine or EASY_WEB_SEARCH_ENGINES)
  need a key  ${wrap(keyed)}

Options:
  -n, --num <k>           max results (default 10)
  --days <n>              time window (ddg: day/week/month; exa: exact; bocha: freshness)
  --site <domain>         restrict to domain (repeatable)
  --exclude-site <domain> exclude domain (repeatable)
  --lang <zh|en>          language/region boost
  --engine <a,b,c>        restrict/enable engines (comma-separated, aliases ok)
  --fast                  quick lookup: ddg, bing, examcp, parallelmcp
  --timeout <sec>         per-attempt timeout (default 8)
  --no-cooldown           ignore the failure cooldown for this run
  --direct                bypass any proxy for all engines (see README Troubleshooting)
  --json                  machine-readable output (adds ok / all_failed)
  -h, --help              show this help

Config: ~/.config/easy-websearch/config.json
Run scripts/doctor.mjs to check engine health.`);
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
    else if (a === "--fast") args.fast = true;
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
function proxyConnect(proxyUrl, host, port, timeout = DEFAULT_TIMEOUT) {
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
    req.setTimeout(timeout, () => req.destroy(new Error("proxy connect timeout")));
    req.on("connect", (res, socket) => {
      // unref(): the tunnel must not keep the event loop alive after the
      // response is done. Without this, a completed search sits for up to a
      // minute waiting on idle proxy sockets before the CLI exits (results
      // are ready in ~2s, the process exits ~65s later).
      if (res.statusCode === 200) { socket.unref(); resolve(socket); }
      else { socket.destroy(); reject(new Error(`proxy CONNECT ${res.statusCode}`)); }
    });
    req.on("error", reject);
    req.end();
  });
}

let FORCE_DIRECT = false; // set by main() from --direct / EASY_WEB_SEARCH_DIRECT
function setForceDirect(v = true) { FORCE_DIRECT = v; }

// CN engines whose anti-bot layers datacenter-rate proxy exits bypass the proxy
// per-host (mirrors search.py's _DIRECT_HOSTS). so360 succeeds direct where the
// same query through the proxy gets a captcha (observed 2026-11).
const DIRECT_HOSTS = new Set([
  "baidu.com", "weixin.sogou.com", "sogou.com", "so.com", "360.cn",
  "localhost", "127.0.0.1",
]);

function shouldBypassProxy(url) {
  try { const h = new URL(url).hostname.toLowerCase(); return [...DIRECT_HOSTS].some((d) => h === d || h.endsWith("." + d)); }
  catch { return false; }
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
    // Transport handles that must be torn down on timeout. A bare reject()
    // leaves them pending and the process alive — measured >30s hang when the
    // proxy accepts the TCP connection but never answers CONNECT.
    let activeSocket = null;
    let activeReq = null;
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const timer = setTimeout(() => {
      try { activeReq?.destroy(); } catch { /* already gone */ }
      try { activeSocket?.destroy(); } catch { /* already gone */ }
      finish(reject, new Error("timeout"));
    }, timeout);
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
    if (proxy && isHttps && !FORCE_DIRECT && !shouldBypassProxy(url)) {
      // Socket is tunneled; request must address the target via the socket.
      proxyConnect(proxy, u.hostname, u.port || 443, timeout).then((socket) => {
        if (settled) { socket.destroy(); return; } // timed out while connecting
        activeSocket = socket;
        const req = mod.request(
          { ...opts, socket, servername: u.hostname, host: u.hostname, port: u.port || 443, path: u.pathname + u.search },
          handler
        );
        activeReq = req;
        req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
        req.on("error", (e) => finish(reject, e));
        if (body) req.write(body);
        req.end();
      }, (e) => finish(reject, e));
    } else if (proxy && !FORCE_DIRECT && !shouldBypassProxy(url)) {
      // Plain http:// through an HTTP proxy uses absolute-form request-URI, not
      // a tunnel. Without this branch http targets silently bypassed the proxy,
      // so the same install reached the network two different ways.
      let pu;
      try { pu = new URL(proxy); } catch { pu = null; }
      if (!pu) { finish(reject, new Error(`invalid proxy URL: ${proxy}`)); return; }
      const req = http.request(
        {
          ...opts,
          host: pu.hostname,
          port: parseInt(pu.port, 10) || 80,
          path: url,
          headers: { ...opts.headers, host: u.host },
        },
        handler
      );
      activeReq = req;
      req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
      req.on("error", (e) => finish(reject, e));
      if (body) req.write(body);
      req.end();
    } else {
      const req = mod.request(url, opts, handler);
      activeReq = req;
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

// Tracking parameters that never change the document — dropping them is what
// lets two URLs for the same article fuse into one hit instead of competing
// with each other. CSDN (ops_request_misc / request_id / biz_id) and
// Alibaba/WeChat share links produced real duplicates in testing.
const TRACKING_PARAM =
  /^(utm_|ref|fbclid|gclid|msclkid|yclid|ops_request_misc|request_id|biz_id|spm|scm|scene|isappinstalled|clicktime|enterid|share_token|share_source|from_source|trk)/i;

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) {
      if (TRACKING_PARAM.test(k)) x.searchParams.delete(k);
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
  const deadline = rotationDeadline(ctx);
  for (const ep of DDG_ENDPOINTS) {
    if (lastErr && rotationExpired(deadline)) break;
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
// Interrogatives carry no topical signal — a SERP that only matches "如何"
// is still answering a different question.
const CJK_STOP_BIGRAMS = new Set([
  "如何", "什么", "怎么", "怎样", "哪些", "哪个", "可以", "是否", "为什", "么样",
  "我们", "你们", "他们", "这个", "那个", "一个", "有没", "没有", "需要",
]);

function cjkBigrams(s) {
  const out = new Set();
  for (const seg of String(s || "").replace(/[^\u4e00-\u9fa5]+/g, " ").split(" ")) {
    for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return out;
}

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
  // 4) CJK queries: under the same pressure bing degrades a multi-word query
  // to its first character and serves a plausible SERP for that
  // ("大模型 论文 综述" → ten dictionary entries for 大, "如何 备份 手机 照片" →
  // the 如何 baike page). If no title shares a 2-char run with the query and
  // no latin query word appears, the whole SERP answers something else.
  if (/[\u4e00-\u9fa5]/.test(query)) {
    const qb = [...cjkBigrams(query)].filter((b) => !CJK_STOP_BIGRAMS.has(b));
    if (qb.length) {
      const latin = query.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [];
      const anyTitleMatch = results.some((r) => {
        const t = String(r.title || "");
        if (latin.some((w) => t.toLowerCase().includes(w))) return true;
        const tb = cjkBigrams(t);
        return qb.some((b) => tb.has(b));
      });
      if (!anyTitleMatch) return true;
    }
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
      } catch { /* not base64 — keep the redirect URL */ }
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
  const deadline = rotationDeadline(ctx);
  for (const host of BING_HOSTS) {
    if (lastErr && rotationExpired(deadline)) break;
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

// Parallel's free MCP endpoint — no API key, returns real page excerpts (same
// class as examcp). Two gotchas: the default undici User-Agent is rate-limited
// by their free tier, and the payload nests a JSON string inside content[0].text.
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";

async function engineParallelMcp(ctx) {
  const payload = {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "web_search", arguments: { objective: ctx.query, search_queries: [ctx.query] } },
  };
  const { status, body } = await fetchText(PARALLEL_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      // Their free tier 429s the default undici agent.
      "user-agent": "easy-websearch",
    },
    body: JSON.stringify(payload),
    timeout: Math.max(ctx.timeout, 20000),
  });
  if (status === 429) throw new Error("Parallel MCP rate limit (free tier) — retry later or set PARALLEL_API_KEY");
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const outer = parseJson(body);
  const text = outer?.result?.content?.[0]?.text;
  if (!text) throw new Error("no results parsed");
  let inner;
  try { inner = JSON.parse(text); } catch { throw new Error("no results parsed"); }
  const items = Array.isArray(inner?.results) ? inner.results : [];
  const out = items
    .filter((r) => r.url && r.title)
    .map((r) => ({
      title: r.title,
      url: r.url,
      snippet: (Array.isArray(r.excerpts) ? r.excerpts.join(" ") : "").replace(/\s+/g, " ").trim().slice(0, 400),
    }));
  if (out.length === 0) throw new Error("no results parsed");
  return out.slice(0, ctx.n);
}

// degoog public instance — keyless Google results (optional DEGOOG_API_KEY for
// instances that protect their search route).
const DEGOOG_BASE = () => (process.env.DEGOOG_URL || "https://degoog.org").replace(/\/+$/, "");

async function engineDegoog(ctx) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (process.env.DEGOOG_API_KEY) headers.authorization = `Bearer ${process.env.DEGOOG_API_KEY}`;
  const { status, body } = await fetchText(`${DEGOOG_BASE()}/api/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: ctx.query, type: "web", page: 1 }),
    timeout: Math.max(ctx.timeout, 15000),
  });
  if (status === 401) throw new Error("degoog instance protects /api/search — set DEGOOG_API_KEY or DEGOOG_URL");
  if (status === 429) throw new Error("degoog rate limit (public instance) — retry later or set DEGOOG_API_KEY");
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.results || [];
  const out = items
    .filter((r) => r.url && r.title)
    .map((r) => ({ title: r.title, url: r.url, snippet: String(r.snippet || "").slice(0, 400) }));
  if (out.length === 0) throw new Error("no results parsed");
  return out.slice(0, ctx.n);
}

// ── Keyless MCP helpers ──────────────────────────────────────────────────
// deepwiki (GitHub repo Q&A) and context7 (library docs) answer over the same
// JSON-RPC shape as exa/parallel; both are free and need no key.
const DEEPWIKI_MCP = "https://mcp.deepwiki.com/mcp";
const CONTEXT7_MCP = "https://mcp.context7.com/mcp";

async function mcpCall(url, toolName, args, timeout = 25000) {
  const payload = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } };
  const { status, body } = await fetchText(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "easy-websearch",
    },
    body: JSON.stringify(payload),
    timeout,
  });
  if (status === 429) throw new Error("MCP rate limit (429) — retry later");
  if (status !== 200) throw new Error(`HTTP ${status}`);
  // Servers answer with plain JSON or with SSE frames — and a streaming server
  // may emit several frames per call, so parse each frame and keep the last one
  // that is actually JSON (joining frames would produce invalid JSON).
  let parsed = null;
  if (body.includes("data:")) {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try { const f = JSON.parse(line.slice(5).trim()); if (f && (f.result || f.error)) parsed = f; } catch { /* partial/keepalive SSE frame — the next frame carries the result */ }
    }
  }
  if (!parsed) {
    try { parsed = JSON.parse(body); } catch { throw new Error("invalid JSON from MCP"); }
  }
  if (parsed.error) throw new Error(parsed.error.message || "MCP error");
  return parsed?.result?.content?.[0]?.text || "";
}

async function engineDeepwiki(ctx) {
  const repo = (ctx.query.match(/\b([\w.-]+\/[\w.-]+)\b/) || [])[1];
  if (!repo) throw new Error("no owner/repo in query");
  const text = await mcpCall(DEEPWIKI_MCP, "ask_wiki_question", { repoName: repo, question: ctx.query });
  if (!text) throw new Error("no results parsed");
  const link = (text.match(/https:\/\/deepwiki\.com\/\S+/) || [])[0] || `https://deepwiki.com/${repo}`;
  return [{ title: `DeepWiki · ${repo}`, url: link, snippet: text.replace(/\s+/g, " ").trim().slice(0, 400) }];
}

async function engineContext7(ctx) {
  const resolved = await mcpCall(CONTEXT7_MCP, "resolve-library-id", { libraryName: ctx.query, query: ctx.query });
  // The resolver returns prose: "Context7-compatible library ID: /websites/rs_tokio"
  const id = (resolved.match(/library ID:\s*(\/[\w./-]+)/i) || resolved.match(/(\/[\w.-]+\/[\w.-]+)/) || [])[1];
  if (!id) throw new Error("no results parsed");
  const docs = await mcpCall(CONTEXT7_MCP, "query-docs", { libraryId: id, query: ctx.query });
  const out = [];
  // Each section carries "Source: <url>"; use it as the citation for that chunk.
  for (const block of docs.split(/(?=^### )/m)) {
    const src = (block.match(/Source:\s*(https?:\/\/\S+)/i) || [])[1];
    if (!src) continue;
    const heading = (block.match(/^###\s+(.+)$/m) || [])[1] || src;
    const body = block.replace(/Source:\s*\S+/i, "").replace(/^###.*$/m, "").replace(/\s+/g, " ").trim();
    out.push({ title: `${heading} — ${id}`, url: src, snippet: body.slice(0, 400) });
    if (out.length >= ctx.n) break;
  }
  if (out.length === 0) {
    out.push({ title: `Context7 · ${id}`, url: `https://context7.com${id}`, snippet: docs.replace(/\s+/g, " ").trim().slice(0, 400) });
  }
  return out;
}

// Exa's free MCP endpoint — no API key, same backend the built-in web_search
// uses. Returns real page highlights instead of a bare SERP, which is why its
// result quality is far above the scraped-HTML engines. Rate-limited (429) on
// the shared free tier, so it fails soft like everything else.
const EXA_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa";

function parseExaMcpText(ctx, text) {
  const out = [];
  // Blocks are separated by a line starting with "Title: ".
  for (const block of text.split(/(?=^Title: )/m)) {
    const title = (block.match(/^Title: (.*)$/m) || [])[1];
    const url = (block.match(/^URL: (\S+)$/m) || [])[1];
    if (!title || !url) continue;
    const highlights = block.split(/^Highlights:\s*$/m)[1] || "";
    out.push({
      title: title.trim(),
      url: url.trim(),
      snippet: highlights.replace(/\s+/g, " ").trim().slice(0, 400),
    });
    if (out.length >= ctx.n) break;
  }
  if (out.length === 0) throw new Error("no results parsed");
  return out;
}

async function engineExaMcp(ctx) {
  const payload = {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "web_search_exa", arguments: { query: ctx.query, numResults: Math.min(ctx.n, 10) } },
  };
  const { status, body } = await fetchText(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-exa-source": "easy-websearch",
    },
    body: JSON.stringify(payload),
    timeout: Math.max(ctx.timeout, 15000),
  });
  if (status === 429) throw new Error("Exa MCP rate limit (free tier) — retry later or set EXA_API_KEY");
  if (status !== 200) throw new Error(`HTTP ${status}`);
  // Server-sent events: keep the last frame that actually carries a result.
  let text = "";
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const frame = JSON.parse(line.slice(5).trim());
      if (frame?.result) text = frame.result.content?.[0]?.text || text;
    } catch { /* partial/keepalive SSE frame — the next frame carries the result */ }
  }
  if (!text) throw new Error("no results parsed");
  return parseExaMcpText(ctx, text);
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
    } catch { /* redirect resolution is best-effort — the wrapper URL still works */ }
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
  const deadline = rotationDeadline(ctx);
  for (const variant of BAIDU_VARIANTS) {
    if (lastErr && rotationExpired(deadline)) break;
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
    } catch { /* redirect resolution is best-effort — the wrapper URL still works */ }
    return u;
  }));
}

// Extract a text snippet from the body right after a result anchor's match.
function snippetAfter(body, from, len = 200) {
  // The window can cut a tag in half, and sogou puts thumbnail <img> markup
  // inside result blurbs. Drop image markup and any dangling partial tag
  // BEFORE stripping, otherwise raw "<img src=..." leaks into the snippet
  // and from there into the agent's answer.
  const windowText = (n) => {
    let s = body.slice(from, from + n);
    const next = s.search(/<h3\b/i); // never bleed into the next result
    if (next > 0) s = s.slice(0, next);
    return stripTags(s.replace(/<img\b[^>]*>/gi, " ").replace(/<[^>]*$/, " "));
  };
  let text = windowText(700);
  // A blurb that is mostly thumbnail leaves nothing behind — look wider.
  if (text.length < 20) text = windowText(1600);
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
    } catch { /* redirect resolution is best-effort — the wrapper URL still works */ }
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
  const deadline = rotationDeadline(ctx);
  for (const variant of SO360_VARIANTS) {
    if (lastErr && rotationExpired(deadline)) break;
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
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const cjk = /[\u4e00-\u9fa5]/.test(q);
  const lang = ["zh", "en"].includes(ctx.lang) ? ctx.lang : cjk ? "zh" : "en";
  const params = new URLSearchParams({
    action: "query", list: "search", srsearch: q,
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
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const params = new URLSearchParams({
    intitle: q, site: "stackoverflow",
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
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const params = new URLSearchParams({ query: q, hitsPerPage: String(Math.min(ctx.n, 10)) });
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
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const params = new URLSearchParams({ q: q, per_page: String(Math.min(ctx.n, 10)) });
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
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const params = new URLSearchParams({ query: q, id_type: "0", cursor: "0", limit: String(Math.min(ctx.n, 10)) });
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
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const params = new URLSearchParams({
    search_query: `all:${q}`,
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
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const params = new URLSearchParams({ q: q, t: "blog", p: "1" });
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
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const params = new URLSearchParams({ search: q, "per-page": String(Math.min(ctx.n, 10)) });
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
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const params = new URLSearchParams({ query: q, rows: String(Math.min(ctx.n, 10)) });
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
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  const headers = { accept: "application/json" };
  const sparams = new URLSearchParams({ db: "pubmed", term: q, retmode: "json", retmax: String(Math.min(ctx.n, 10)) });
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
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const params = new URLSearchParams({ search: q, limit: String(Math.min(ctx.n, 10)) });
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

// ── Owner-requested expansion (v1.9, probe evidence in engine-notes) ──

// Google Custom Search JSON API — free 100 queries/day, official Google
// results. Needs BOTH GOOGLE_API_KEY and a Programmable Search Engine cx.
async function engineGoogleCse(ctx) {
  const cx = process.env.GOOGLE_CX;
  if (!cx) throw new Error("GOOGLE_CX not set — create a search engine at programmablesearchengine.google.com and put its id in GOOGLE_CX");
  const p = new URLSearchParams({ key: process.env.GOOGLE_API_KEY, cx, q: ctx.query, num: String(Math.min(Math.max(ctx.n, 1), 10)) });
  if (ctx.lang === "zh") p.set("hl", "zh-CN");
  else if (ctx.lang === "en") p.set("hl", "en");
  const { status, body } = await fetchText(`https://www.googleapis.com/customsearch/v1?${p}`, {
    timeout: ctx.timeout, headers: { accept: "application/json" },
  });
  if (status !== 200) {
    let msg = "";
    try { msg = ": " + String(parseJson(body)?.error?.message || "").slice(0, 100); } catch { /* partial/keepalive SSE frame — the next frame carries the result */ }
    throw new Error(`HTTP ${status}${msg}`);
  }
  const items = parseJson(body)?.items || [];
  return items
    .filter((r) => r.link && r.title)
    .map((r) => ({ title: r.title, url: r.link, snippet: (r.snippet || "").slice(0, 400) }));
}

// Semantic Scholar Graph API — free, keyless (shared per-IP anonymous pool,
// often 429 from proxy/datacenter exits); a free S2_API_KEY lifts the limit.
async function engineSemanticScholar(ctx) {
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const p = new URLSearchParams({
    query: q, limit: String(Math.min(ctx.n, 10)),
    fields: "title,url,year,venue,citationCount",
  });
  const headers = { accept: "application/json", ...(process.env.S2_API_KEY && { "x-api-key": process.env.S2_API_KEY }) };
  const { status, body } = await fetchText(`https://api.semanticscholar.org/graph/v1/paper/search?${p}`, {
    timeout: ctx.timeout, headers,
  });
  if (status === 429) throw new Error("Semantic Scholar rate limit (shared anonymous pool) — retry later or set S2_API_KEY (free)");
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body)?.data || [];
  return items
    .filter((r) => r.url && r.title)
    .map((r) => ({
      title: r.title,
      url: r.url,
      snippet: [r.year, r.venue, r.citationCount != null ? `${r.citationCount} citations` : ""].filter(Boolean).join(" · "),
    }));
}

// Bing News RSS — keyless, CN-reachable. Item links are apiclick.aspx
// wrappers carrying the real target in the url= param (observed 2026-11-09);
// News:Source carries the publisher.
function parseBingNewsRss(ctx, body) {
  const results = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  for (const m of body.matchAll(itemRe)) {
    if (results.length >= ctx.n * 2) break;
    const item = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    const title = stripTags((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const link = decodeEntities((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "");
    // url= is the last param and carries the raw target — take the rest greedily.
    const up = link.match(/[?&]url=(.+)$/);
    const url = up ? decodeURIComponent(up[1]) : link;
    const source = stripTags((item.match(/<News:Source>([\s\S]*?)<\/News:Source>/) || [])[1] || "");
    const date = stripTags((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "");
    if (!/^https?:\/\//.test(url) || !title) continue;
    results.push({ title, url, snippet: [source, date].filter(Boolean).join(" · ") });
  }
  if (results.length === 0) throw new Error("no results parsed");
  return results;
}

async function engineBingNews(ctx) {
  const p = new URLSearchParams({ q: ctx.query, format: "rss" });
  if (ctx.lang === "zh") p.set("setmkt", "zh-CN");
  else if (ctx.lang === "en") p.set("setmkt", "en-US");
  const { status, body } = await fetchText(`https://www.bing.com/news/search?${p}`, {
    timeout: ctx.timeout,
    headers: { referer: "https://www.bing.com/", "upgrade-insecure-requests": "1" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return parseBingNewsRss(ctx, body);
}

// Gitee API v5 — anonymous search returns EMPTY arrays (observed 2026-11-09),
// so this engine is gated on a free GITEE_TOKEN. Routed only when the token
// exists (see routeAuto) to keep token-less runs noise-free.
async function engineGitee(ctx) {
  // Vertical engines index English — prefer the extracted ASCII run when
  // routing supplied one, but never rewrite the general-web query.
  const q = ctx.intlQuery || ctx.query;
  const p = new URLSearchParams({ q: q, per_page: String(Math.min(ctx.n, 10)) });
  p.set("access_token", process.env.GITEE_TOKEN);
  const { status, body } = await fetchText(`https://gitee.com/api/v5/search/repositories?${p}`, {
    timeout: ctx.timeout, headers: { accept: "application/json" },
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = parseJson(body) || [];
  return items
    .filter((r) => r.html_url && (r.full_name || r.human_name))
    .map((r) => ({
      title: `${r.human_name || r.full_name} ⭐${r.stargazers_count ?? 0}`,
      url: r.html_url,
      snippet: (r.description || "").slice(0, 300),
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
  // Keyless Exa MCP (free tier) — the backend the built-in web_search uses.
  examcp: { fn: engineExaMcp, key: null },
  // Keyless Parallel MCP (free tier) — page excerpts, like examcp.
  parallelmcp: { fn: engineParallelMcp, key: null },
  // Keyless MCP verticals: repo Q&A and library docs (auto tier).
  deepwiki: { fn: engineDeepwiki, key: null, auto: true },
  context7: { fn: engineContext7, key: null, auto: true },
  // Keyless degoog public instance — Google results.
  degoog: { fn: engineDegoog, key: null },
  firecrawl: { fn: engineFirecrawl, key: "FIRECRAWL_API_KEY" },
  bocha: { fn: engineBocha, key: "BOCHA_API_KEY" },
  metaso: { fn: engineMetaso, key: "METASO_API_KEY" },
  linkup: { fn: engineLinkup, key: "LINKUP_API_KEY" },
  ollama: { fn: engineOllama, key: "OLLAMA_API_KEY" },
  searxng: { fn: engineSearxng, key: "SEARXNG_BASE_URL" },
  // ── Vertical engines (official keyless APIs) — auto tier ──
  wikipedia: { fn: engineWikipedia, key: null, auto: true },
  stackexchange: { fn: engineStackExchange, key: null, auto: true },
  github: { fn: engineGithub, key: null, auto: true },
  bingnews: { fn: engineBingNews, key: null, auto: true },
  semanticscholar: { fn: engineSemanticScholar, key: "S2_API_KEY", optionalKey: true, auto: true },
  gitee: { fn: engineGitee, key: "GITEE_TOKEN", auto: true },
  hn: { fn: engineHn, key: null, auto: true },
  juejin: { fn: engineJuejin, key: null, auto: true },
  arxiv: { fn: engineArxiv, key: null, auto: true },
  mwmbl: { fn: engineMwmbl, key: null },
  // ── Academic / registry (official keyless APIs) — auto tier ──
  csdn: { fn: engineCSDN, key: null, auto: true },
  openalex: { fn: engineOpenAlex, key: null, auto: true },
  crossref: { fn: engineCrossref, key: null, auto: true },
  pubmed: { fn: enginePubMed, key: null, auto: true },
  googlecse: { fn: engineGoogleCse, key: "GOOGLE_API_KEY" },
  huggingface: { fn: engineHuggingFace, key: null, auto: true },
  // Keyless backup engines: anonymous quotas are low, so they stay OFF by
  // default. Opt in via --engine or the EASY_WEB_SEARCH_ENGINES env var.
  anysearch: { fn: engineAnysearch, key: "ANYSEARCH_API_KEY", optionalKey: true, backup: true },
  keenable: { fn: engineKeenable, key: "KEENABLE_API_KEY", optionalKey: true, backup: true },
  // Keyless vertical engine (WeChat articles only) — opt-in like backups.
  sogouweixin: { fn: engineSogouWeixin, key: null, backup: true },
};

// Key-gated providers live in their own module to keep this file navigable.
Object.assign(ENGINES, buildExtraEngines({ fetchText, parseJson }));

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

// Endpoint rotation gives an engine retries at its own timeout each; without a
// shared budget a dead first endpoint costs the full chain (observed: ddg 3
// endpoints × retry × 8s = 16s wall). The budget caps total wall time per
// engine at timeout × ROTATION_BUDGET, checked before each new attempt.
const ROTATION_BUDGET = 2;

function rotationDeadline(ctx) {
  return Date.now() + ctx.timeout * ROTATION_BUDGET;
}

function rotationExpired(deadline) {
  return Date.now() >= deadline;
}

function routeAuto(query) {
  const add = [];
  const q = query.toLowerCase();
  if (/(github|gitee|开源仓库|源码|repo\b|open[- ]?source)/.test(q)) {
    add.push("github");
    // Gitee anonymous search is empty (engine-notes v1.9) — only route when tokened.
    if (process.env.GITEE_TOKEN) add.push("gitee");
  }
  if (/(stackoverflow|stack\s?exchange|报错|exception|traceback|怎么解决|how to (fix|debug))/.test(q)) add.push("stackexchange");
  if (/(论文|文献|arxiv|学术|research paper|preprint)/.test(q)) add.push("arxiv", "openalex", "crossref", "pubmed", "semanticscholar");
  if (/(新闻|快讯|资讯|breaking news|latest news)/.test(q)) add.push("bingnews");
  if (/(什么是|是什么|啥是|是啥|什么意思|百科|维基百科|wikipedia|是谁|who is|history of)/.test(q)) add.push("wikipedia");
  if (/(hacker\s?news|show\s?hn|tech news|科技新闻)/.test(q)) add.push("hn");
  // Tech-vertical engines: only useful for technical questions, and actively
  // harmful elsewhere (a medical query returned "React 面试题" and "鸿蒙 Next"
  // from juejin). Broad but concrete — must fire for "python 虚拟环境", not for
  // "喝柠檬水能防癌".
  if (/(编程|代码|程序员|开发者|教程|报错|调试|\bbug\b|算法|面试|框架|源码|数据库|\bsql\b|docker|k8s|kubernetes|linux|\bgit\b|\bapi\b|\bsdk\b|javascript|typescript|python|\bjava\b|golang|\brust\b|\breact\b|\bvue\b|node\.?js|webpack|vite|\bcss\b|\bhtml\b|掘金|juejin|csdn|机器学习|深度学习|大模型|\bllm\b|模型部署|神经网络)/.test(q)) add.push("juejin", "csdn");
  if (/(huggingface|数据集|dataset|模型权重|safetensors)/.test(q)) add.push("huggingface");
  // Repo Q&A: only when the query actually names an owner/repo.
  if (/(github|仓库|源码|实现|架构|internals|architecture|codebase)/.test(q)
      && /\b[\w.-]+\/[\w.-]+\b/.test(q)) add.push("deepwiki");
  // Library docs: a docs-ish ask about a library/API.
  if (/(文档|用法|怎么用|\bapi\b|\bdocs?\b|usage|教程)/.test(q)
      && /(python|javascript|typescript|rust|\bgo\b|\bjava\b|react|vue|node|tokio|npm|pip|docker|sql|redis|kafka|fastapi|django|flask|express|next\.?js)/.test(q)) add.push("context7");
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
// Scraped SERP engines are where bot junk comes from: under load bing answers a
// Chinese query with Korean forum spam, adult listings or a bare site name.
// The content engines (examcp/parallelmcp/degoog) are semantically matched and
// are never touched by this rule.
const SCRAPED_SERP = new Set(["ddg", "bing", "baidu", "sogouweb", "so360"]);
// Drop a scraped-SERP hit that is demonstrably about something else. Validated
// against a hand-checked corpus of 5 queries / 50 results: 8 junk dropped,
// 0 legitimate hits lost.
function isOffTopicScrapedHit(r, query) {
  if (!r.engines.every((e) => SCRAPED_SERP.has(e))) return false;
  const title = r.title || "";
  const lower = title.toLowerCase();
  const latin = query.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [];
  if (latin.length && latin.some((w) => lower.includes(w))) return false;
  if (!/[\u4e00-\u9fa5]/.test(query)) return false;
  // Script mismatch: Korean/Japanese page for a Chinese query.
  if (/[\uac00-\ud7af]/.test(title) && !/[\uac00-\ud7af]/.test(query)) return true;
  if (/[\u3040-\u30ff]/.test(title) && !/[\u3040-\u30ff]/.test(query)) return true;
  // Latin-only title with no query term ("Web of Science").
  if (!/[\u4e00-\u9fa5]/.test(title)) return true;
  // Chinese title that shares no 2-char run with the query.
  const qb = [...cjkBigrams(query)].filter((b) => !CJK_STOP_BIGRAMS.has(b));
  if (qb.length && !qb.some((b) => cjkBigrams(title).has(b))) return true;
  return false;
}

function fuse(engineResults) {
  const byUrl = new Map();
  for (const { name, results } of engineResults) {
    results.forEach((r, idx) => {
      const key = normalizeUrl(r.url);
      if (!byUrl.has(key)) byUrl.set(key, { ...r, url: r.url, score: 0, engines: [], ranks: [] });
      const item = byUrl.get(key);
      // Prefer the already-clean URL for display/citation when one arrives.
      if (item.url !== key && r.url === key) item.url = r.url;
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
  } catch { /* cooldown is an optimization — never fail the search over its bookkeeping */ }
}

// ---------------------------------------------------------------- main ----
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (!args.query) {
    console.error(`${USAGE}\nRun with --help for details.`);
    process.exit(2);
  }
  // --fast is for quick lookups: its pool is small but the scrapers rotate
  // endpoints on failure, so the default 8s timeout turned a dead ddg into a
  // 16s wall. Quick lookups want a short fuse by default.
  FORCE_DIRECT = args.direct || process.env.EASY_WEB_SEARCH_DIRECT === "1";
  // --fast default timeout: 4s. Only applies when the user did not pass
  // --timeout explicitly (parseArgs leaves the DEFAULT_TIMEOUT marker).
  if (args.fast && args.timeout === DEFAULT_TIMEOUT) args.timeout = 4000;
  const ctx = { ...args, query: buildQuery(args) };
  if (args.engines) {
    const requested = args.engines.split(",").map((s) => s.trim()).filter(Boolean);
    const resolved = [];
    const unknown = [];
    for (const raw of requested) {
      const name = resolveEngineName(raw);
      if (name) { if (!resolved.includes(name)) resolved.push(name); }
      else unknown.push(raw);
    }
    if (unknown.length) {
      // Name what is wrong, suggest a fix, and keep the full list behind --help
      // instead of dumping 70 names on every typo.
      for (const raw of unknown) {
        const guess = suggestEngine(raw);
        console.error(`Unknown engine: ${raw}${guess ? ` — did you mean "${guess}"?` : ""}`);
      }
      console.error("Run with --help for the full engine list, or --engine to pick from it.");
      process.exit(2);
    }
    args.engines = resolved.join(",");
  }
  let engines;
  if (args.fast && !args.engines) {
    // Quick lookups: skip the slow/unreliable scrapers and the verticals.
    const fastSet = ["ddg", "bing", "examcp", "parallelmcp"];
    engines = fastSet.filter((n) => ENGINES[n]);
  } else {
    engines = availableEngines(args.engines);
  }
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
    // Only expose the extracted ASCII run to vertical engines (they opt in via
    // ctx.intlQuery). Rewriting ctx.query would drop the Chinese half of a
    // mixed query for every general-web engine.
    if (routed.engines.length) ctx.intlQuery = routed.intlQuery;
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

  // Persist cooldown bookkeeping: successes clear, failures arm a cooldown, and
  // an engine that keeps answering with zero hits is benched too — a dead
  // upstream (searxng whose own backends are rate-limited) should stop taking a
  // slot on every run instead of costing seconds for nothing.
  const COOLDOWN_MS_EMPTY = 5 * 60 * 1000;
  const EMPTY_STREAK_LIMIT = 2;
  let dirty = false;
  for (const s of statuses) {
    if (s.ok && s.count > 0) {
      if (state[s.name]) { delete state[s.name]; dirty = true; }
    } else if (s.ok) {
      const zeros = (state[s.name]?.zeros || 0) + 1;
      if (zeros >= EMPTY_STREAK_LIMIT) {
        state[s.name] = { until: Date.now() + COOLDOWN_MS_EMPTY, reason: `no results in ${zeros} consecutive queries`, zeros };
        dirty = true;
      } else if (state[s.name]?.zeros !== zeros) {
        state[s.name] = { ...(state[s.name] || {}), zeros };
        dirty = true;
      }
    } else if ((state[s.name]?.until ?? 0) < Date.now() + COOLDOWN_MS_MAX) {
      // Escalating cooldown: first failure 2 min (transient blips), repeats 10 min.
      const failures = (state[s.name]?.failures || 0) + 1;
      const ms = failures === 1 ? COOLDOWN_MS_FIRST : COOLDOWN_MS_MAX;
      state[s.name] = { until: Date.now() + ms, reason: s.error.slice(0, 120), failures };
      dirty = true;
    }
  }
  if (dirty && !args.noCooldown) saveCooldowns(state);

  // "ok but zero hits" is not a failure. Label it so a caller never mistakes
  // an idle engine for a broken one.
  for (const s of statuses) {
    if (s.ok && s.count === 0) s.note = "reachable, no hits for this query";
  }

  // --days is not supported by every engine — say so instead of silently
  // ignoring it.
  if (args.days > 0) {
    for (const s of statuses) {
      if (s.name === "bing" && s.ok) s.note = "days ignored by bing";
    }
  }

  const allEngines = [...cooldownSkipped, ...statuses];
  let ranked = fuse(statuses.filter((s) => s.ok));
  // --site / --exclude-site are enforced HERE, not only by handing the site:
  // operator to engines: vertical engines ignore it outright (juejin, csdn,
  // github...) and bing does not always honour it, so "restrict to domain"
  // was advisory. Filtering the fused set makes the promise true for every
  // engine.
  if (args.site.length || args.excludeSite.length) {
    const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
    const norm = (d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    const sites = args.site.map(norm).filter(Boolean);
    const excluded = args.excludeSite.map(norm).filter(Boolean);
    const inDomain = (h, d) => h === d || h.endsWith(`.${d}`);
    ranked = ranked.filter((r) => {
      const h = hostOf(r.url);
      if (sites.length && !sites.some((d) => inDomain(h, d))) return false;
      if (excluded.some((d) => inDomain(h, d))) return false;
      return true;
    });
  }
  const fused = ranked.filter((r) => !isOffTopicScrapedHit(r, ctx.query)).slice(0, args.n);

  const answered = statuses.filter((st) => st.ok);
  const failedEngines = statuses.filter((st) => !st.ok).map((st) => st.name);
  const allFailed = answered.length === 0;

  if (args.json) {
    console.log(JSON.stringify({
      query: ctx.query,
      // Top-level status so a script can tell "nothing found" from "everything
      // broke" without walking the engines array.
      ok: fused.length > 0,
      all_failed: allFailed,
      engines_ok: answered.map((st) => st.name),
      engines_failed: failedEngines,
      engines: allEngines.map(({ name, ok, count, ms, error, note }) => ({ name, ok, count, ms, error, ...(note ? { note } : {}) })),
      results: fused.map((r, i) => ({
        rank: i + 1, title: r.title, url: r.url, snippet: r.snippet,
        score: +r.score.toFixed(4), engines: r.engines,
      })),
    }, null, 2));
    if (allFailed) process.exitCode = 1;
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

export { ENGINES, availableEngines, parseArgs, buildQuery, looksLikeJunk, isOffTopicScrapedHit, cooldownPath, searxngBaseAndAuth, setForceDirect, shouldBypassProxy, routeAuto, extractIntlQuery, fetchText, stripTags, parseJson, normalizeUrl, fuse,
  // SERP parsers (tested against tests/snapshots/ in both runtimes)
  parseDdgHtml, parseDdgLite, parseBingResults, parseBingRss, parseBaiduResults, parseSo360Desktop, parseSo360Mobile, parseBingNewsRss };
