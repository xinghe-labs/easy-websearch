#!/usr/bin/env node
/**
 * easy-websearch CLI dispatcher — thin router to the skill's scripts.
 * Zero npm dependencies. Node >= 18.
 *
 *   easy-websearch search "query" [--lang zh] [-n 5] [--json] …
 *   easy-websearch fetch <url> [--json]
 *   easy-websearch doctor [--json] [--clear-cooldown]
 *   easy-websearch setup [--dir <skills-dir>]
 *   easy-websearch --help
 *
 * All flags are passed through to the underlying scripts unchanged.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(scriptDir, "..", "package.json"), "utf8"));
const SCRIPTS = {
  search: "search.mjs",
  fetch: "fetch.mjs",
  doctor: "doctor.mjs",
  setup: "setup.mjs",
};

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(`easy-websearch — multi-engine web search for AI agents (v${pkg.version})

Usage:
  easy-websearch search "query" [options]   multi-engine web search (RRF fused)
  easy-websearch fetch <url> [options]      read a page as Markdown
  easy-websearch doctor [options]           engine health check
  easy-websearch setup [options]            install the skill into agent dirs

Common search options:  --lang zh|en   -n 10   --days 7   --site d
                        --engine ddg,bing   --json   --timeout 8
Run 'easy-websearch search --help' for the full option list of each command.
Docs: https://github.com/xinghe-labs/easy-websearch`);
  process.exit(0);
}

const script = SCRIPTS[cmd];
if (!script) {
  console.error(`Unknown command: ${cmd}\nValid: ${Object.keys(SCRIPTS).join(", ")}, --help`);
  process.exit(2);
}

const result = spawnSync(process.execPath, [path.join(scriptDir, script), ...rest], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
