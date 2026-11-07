#!/usr/bin/env node
/**
 * easy-websearch doctor — diagnose engine availability and configuration.
 * Zero npm dependencies. Node >= 18.
 *
 * Usage:
 *   node doctor.mjs [--timeout 8] [--json]
 *
 * Runs one tiny real search per available engine (concurrently) and reports
 * per-engine status, latency, and configuration gaps. Exit code: 0 all tested
 * engines OK, 1 any failure, 2 nothing testable.
 */
import { readFileSync } from "node:fs";
import { ENGINES, availableEngines, cooldownPath, setForceDirect } from "./search.mjs";

const args = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const timeoutSec = parseInt(getOpt("--timeout", "8"), 10) || 8;
const asJson = args.includes("--json");
if (args.includes("--direct") || process.env.EASY_WEB_SEARCH_DIRECT === "1") {
  setForceDirect(true);
}
const timeoutMs = timeoutSec * 1000;

// --clear-cooldown: reset the failure-cooldown state and exit.
if (args.includes("--clear-cooldown")) {
  const { rmSync } = await import("node:fs");
  try { rmSync(cooldownPath()); console.log("cooldown state cleared: " + cooldownPath()); }
  catch { console.log("no cooldown state to clear (" + cooldownPath() + ")"); }
  process.exit(0);
}

const ALL = Object.keys(ENGINES);
const defaultSet = availableEngines("");
const optIn = (process.env.EASY_WEB_SEARCH_ENGINES || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const ctx = { query: "hello world", n: 1, days: 0, lang: "", timeout: timeoutMs, engines: "", json: false };

// Surface cooldown state so users see why an engine was being skipped.
let cooldownState = {};
try { cooldownState = JSON.parse(readFileSync(cooldownPath(), "utf8")) || {}; } catch { /* no state file */ }
const cooldownNote = (name) => {
  const cd = cooldownState[name];
  return cd?.until > Date.now() ? ` [cooldown: ${cd.reason || "recent failure"}]` : "";
};

// Where to apply for each engine's key (shown in SKIP notes — BYOK friction
// should be near zero).
const KEY_URLS = {
  BRAVE_API_KEY: "brave.com/search/api",
  TAVILY_API_KEY: "app.tavily.com",
  SERPER_API_KEY: "serper.dev",
  EXA_API_KEY: "dashboard.exa.ai",
  FIRECRAWL_API_KEY: "firecrawl.dev",
  BOCHA_API_KEY: "open.bochaai.com",
  METASO_API_KEY: "metaso.cn/search-api/api-keys",
  LINKUP_API_KEY: "linkup.so",
  OLLAMA_API_KEY: "ollama.com → Account → API keys",
  SEARXNG_BASE_URL: "self-hosted — see README SearXNG section",
  ANYSEARCH_API_KEY: "anysearch.com",
  KEENABLE_API_KEY: "keenable.ai",
};

const rows = await Promise.all(ALL.map(async (name) => {
  const e = ENGINES[name];
  const key = typeof e === "function" ? null : e.key;
  const optionalKey = typeof e === "object" && !!e.optionalKey;
  const backup = typeof e === "object" && !!e.backup;
  const keyMissing = key && !process.env[key] && !optionalKey;
  const enabled = defaultSet.includes(name) || optIn.includes(name);
  if (keyMissing) {
    const where = KEY_URLS[key] ? ` — get it: ${KEY_URLS[key]}` : "";
    return { engine: name, status: "SKIP", ms: 0, note: `${key} not set${where}` };
  }
  const t0 = Date.now();
  try {
    const fn = typeof e === "function" ? e : e.fn;
    const results = await fn(ctx);
    return {
      engine: name, status: "OK", ms: Date.now() - t0,
      note: `${results.length} result${results.length === 1 ? "" : "s"}` +
        (backup ? " [backup]" : "") + (enabled ? "" : " [not in default set]") + cooldownNote(name),
    };
  } catch (err) {
    return { engine: name, status: "FAIL", ms: Date.now() - t0, note: err.message + cooldownNote(name) };
  }
}));

const tested = rows.filter((r) => r.status !== "SKIP");
const failed = rows.filter((r) => r.status === "FAIL");
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy || "";
const SCRAPE = ["ddg", "bing", "baidu", "sogouweixin"];
const scrapeFailed = failed.filter((r) => SCRAPE.includes(r.engine));
const proxyHint = (proxy && scrapeFailed.length >= 2)
  ? [`hint: ${scrapeFailed.length} scrape engines failed while a proxy is active —`,
     `      anti-bot layers block datacenter proxy exits. Bypass with:`,
     `      no_proxy=<domain>  |  EASY_WEB_SEARCH_DIRECT=1  |  doctor --direct`]
  : [];

if (asJson) {
  console.log(JSON.stringify({
    node: process.version,
    proxy: proxy || null,
    cooldownStateFile: cooldownPath(),
    hints: proxyHint,
    engines: rows,
    summary: { tested: tested.length, failed: failed.length, skipped: rows.length - tested.length },
  }, null, 2));
} else {
  console.log(`easy-websearch doctor — node ${process.version}${proxy ? ` | proxy: ${proxy}` : " | no proxy env"}`);
  const w = Math.max(...rows.map((r) => r.engine.length)) + 2;
  for (const r of rows) {
    const mark = r.status === "OK" ? "✓" : r.status === "FAIL" ? "✗" : "–";
    console.log(`  ${mark} ${r.engine.padEnd(w)} ${r.status.padEnd(5)} ${String(r.ms).padStart(5)}ms  ${r.note}`);
  }
  console.log(`\n${tested.length} tested, ${rows.length - tested.length} skipped, ${failed.length} failed`);
  for (const line of proxyHint) console.log(line);
}
process.exit(failed.length ? 1 : tested.length ? 0 : 2);
