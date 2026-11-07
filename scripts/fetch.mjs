#!/usr/bin/env node
/**
 * easy-web-search fetch — extract readable content from a URL as Markdown.
 * Zero npm dependencies. Node >= 18.
 *
 * Usage:
 *   node fetch.mjs <url> [--json] [--timeout 15] [--max-chars 20000]
 *
 * Strategy (reliability-first):
 *   1. Direct fetch + built-in HTML-to-Markdown extraction.
 *   2. If blocked (403/429/5xx) or extraction is empty → r.jina.ai reader
 *      fallback (free, no key; may be rate-limited).
 * Always exits 0 with --json and reports {"ok": false} instead of crashing.
 */
import http from "node:http";
import https from "node:https";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DEFAULT_TIMEOUT = 15000;

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith("-"));
const flags = { json: argv.includes("--json") };
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
flags.timeout = (parseInt(getOpt("--timeout", "15"), 10) || 15) * 1000;
flags.maxChars = parseInt(getOpt("--max-chars", "20000"), 10) || 20000;
if (!url) {
  console.error("Usage: node fetch.mjs <url> [--json] [--timeout 15] [--max-chars 20000]");
  process.exit(2);
}

// ------------------------------------------------------------- fetch ----
function proxyConnect(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    let pu;
    try { pu = new URL(proxyUrl); } catch { return reject(new Error(`invalid proxy URL: ${proxyUrl}`)); }
    const req = http.request({
      host: pu.hostname, port: parseInt(pu.port, 10) || 80, method: "CONNECT",
      path: `${host}:${port}`, headers: { host: `${host}:${port}` },
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

function fetchText(url, { headers = {}, timeout = DEFAULT_TIMEOUT } = {}) {
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
    const opts = { method: "GET", headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8", ...headers } };
    const handler = (res) => {
      // Follow up to 5 redirects ourselves (keeps the proxy tunnel intact).
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        fetchText(next, { headers, timeout }).then((v) => finish(resolve, v), (e) => finish(reject, e));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => finish(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), finalUrl: url }));
    };
    if (proxy && isHttps) {
      proxyConnect(proxy, u.hostname, u.port || 443).then((socket) => {
        const req = mod.request({ ...opts, socket, servername: u.hostname, host: u.hostname, port: u.port || 443, path: u.pathname + u.search }, handler);
        req.on("error", (e) => finish(reject, e));
        req.end();
      }, (e) => finish(reject, e));
    } else {
      const req = mod.request(url, opts, handler);
      req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
      req.on("error", (e) => finish(reject, e));
      req.end();
    }
  });
}

// -------------------------------------------------- html → markdown ----
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", hellip: "…", copy: "©" };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (ENTITIES[e]) return ENTITIES[e];
    if (e[0] === "#") {
      const num = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : m;
    }
    return m;
  });
}
const inline = (s) =>
  decodeEntities(s.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")).replace(/[ \t]+/g, " ").trim();

function htmlToMarkdown(html) {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<(nav|header|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const desc = (h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
                h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) || [])[1];
  h = h
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lv, t) => `\n\n${"#".repeat(+lv)} ${inline(t)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${inline(t)}`)
    .replace(/<\/(p|div|section|article|tr|blockquote|pre)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n\n---\n\n")
    .replace(/<[^>]*>/g, " ");
  let text = decodeEntities(h).replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  const meta = [];
  if (title && title.trim()) meta.push(`# ${inline(title)}`);
  if (desc) meta.push(`> ${inline(desc)}`);
  if (meta.length) text = meta.join("\n\n") + "\n\n" + text;
  return text;
}

// ---------------------------------------------------------------- main ----
async function run() {
  // 1) Direct fetch + local extraction.
  try {
    const { status, body } = await fetchText(url, { timeout: flags.timeout });
    if (status === 200 && /<\w+[\s\S]*>/.test(body)) {
      const md = htmlToMarkdown(body);
      if (md.length > 200) {
        return { ok: true, via: "direct", url, chars: md.length, content: md.slice(0, flags.maxChars) };
      }
    }
  } catch { /* direct fetch failed (blocked/timeout/empty) → reader fallback */ }

  // 2) r.jina.ai reader fallback (free, no key; rate-limited).
  const { status, body } = await fetchText(`https://r.jina.ai/${url}`, {
    headers: { accept: "text/plain" }, timeout: flags.timeout,
  });
  if (status === 200 && body && body.trim().length > 100) {
    return { ok: true, via: "r.jina.ai", url, chars: body.length, content: body.slice(0, flags.maxChars) };
  }
  return { ok: false, url, error: `direct extraction failed; reader fallback HTTP ${status}` };
}

const out = await run();
if (flags.json) {
  console.log(JSON.stringify(out, null, 2));
} else if (out.ok) {
  console.log(out.content);
  console.error(`\n--- [via ${out.via}, ${out.chars} chars] ---`);
} else {
  console.error(`FAILED: ${out.error}`);
  process.exit(1);
}
