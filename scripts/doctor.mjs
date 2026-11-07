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
import { ENGINES, availableEngines } from "./search.mjs";

const args = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const timeoutSec = parseInt(getOpt("--timeout", "8"), 10) || 8;
const asJson = args.includes("--json");
const timeoutMs = timeoutSec * 1000;

const ALL = Object.keys(ENGINES);
const defaultSet = availableEngines("");
const optIn = (process.env.EASY_WEB_SEARCH_ENGINES || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const ctx = { query: "hello world", n: 1, days: 0, lang: "", timeout: timeoutMs, engines: "", json: false };

const rows = await Promise.all(ALL.map(async (name) => {
  const e = ENGINES[name];
  const key = typeof e === "function" ? null : e.key;
  const optionalKey = typeof e === "object" && !!e.optionalKey;
  const backup = typeof e === "object" && !!e.backup;
  const keyMissing = key && !process.env[key] && !optionalKey;
  const enabled = defaultSet.includes(name) || optIn.includes(name);
  if (keyMissing) {
    return { engine: name, status: "SKIP", ms: 0, note: `${key} not set` };
  }
  const t0 = Date.now();
  try {
    const fn = typeof e === "function" ? e : e.fn;
    const results = await fn(ctx);
    return {
      engine: name, status: "OK", ms: Date.now() - t0,
      note: `${results.length} result${results.length === 1 ? "" : "s"}` +
        (backup ? " [backup]" : "") + (enabled ? "" : " [not in default set]"),
    };
  } catch (err) {
    return { engine: name, status: "FAIL", ms: Date.now() - t0, note: err.message };
  }
}));

const tested = rows.filter((r) => r.status !== "SKIP");
const failed = rows.filter((r) => r.status === "FAIL");
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy || "";

if (asJson) {
  console.log(JSON.stringify({
    node: process.version,
    proxy: proxy || null,
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
}
process.exit(failed.length ? 1 : tested.length ? 0 : 2);
