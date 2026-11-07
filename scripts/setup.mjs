#!/usr/bin/env node
/**
 * easy-websearch setup — one-command onboarding.
 * Zero npm dependencies. Node >= 18.
 *
 *   node scripts/setup.mjs              detect agent dirs → install → verify
 *   node scripts/setup.mjs --dir <path> install into a specific skills dir
 *                                       (repeatable)
 *   node scripts/setup.mjs --list       only show detected dirs
 *
 * What it does:
 *   1. Finds agent skill directories that exist (~/.claude/skills,
 *      ~/.agents/skills, project-level .claude/skills, .agents/skills).
 *      If none exist, defaults to ~/.claude/skills.
 *   2. Copies this skill folder into <dir>/easy-websearch (safe excludes:
 *      .git, sandbox, caches). Existing installs are updated in place.
 *   3. Runs the doctor health check from the installed copy and prints a
 *      summary.
 *   4. Prints what to do next (talk to your agent; optional keys).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, ".."); // the folder to install
const NAME = "easy-websearch";

const help = () => {
  console.log(`Usage: node scripts/setup.mjs [--dir <skills-dir>]... [--list]

Detects agent skill directories, installs ${NAME} into them (in-place update
if already present), then runs the doctor health check and prints next steps.
`);
};

// ------------------------------------------------------------ cli args ----
const dirs = [];
let listOnly = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--help" || argv[i] === "-h") { help(); process.exit(0); }
  else if (argv[i] === "--list") listOnly = true;
  else if (argv[i] === "--dir") {
    const v = argv[++i];
    if (!v || v.startsWith("-")) { console.error("Missing value for --dir"); process.exit(2); }
    dirs.push(path.resolve(v));
  } else {
    console.error(`Unknown argument: ${argv[i]}\nRun with --help for details.`);
    process.exit(2);
  }
}

const home = os.homedir();
const candidates = [
  { dir: path.join(home, ".claude", "skills"), who: "Claude Code (user)" },
  { dir: path.join(home, ".agents", "skills"), who: "Agent Skills standard (user)" },
  { dir: path.resolve(".claude", "skills"), who: "Claude Code (project)" },
  { dir: path.resolve(".agents", "skills"), who: "Agent Skills standard (project)" },
];
const detected = candidates.filter((c) => fs.existsSync(c.dir));

if (listOnly) {
  console.log("Detected agent skill directories:");
  for (const c of detected) console.log(`  ${c.dir}  (${c.who})`);
  if (!detected.length) console.log("  (none found — setup will default to ~/.claude/skills)");
  if (dirs.length) console.log("Explicit --dir targets:", dirs.join(", "));
  process.exit(0);
}

// -------------------------------------------------------------- targets ----
let targets;
if (dirs.length) {
  targets = [...new Set(dirs)].map((d) => ({ dir: d, who: "explicit --dir" }));
} else if (detected.length) {
  targets = detected;
} else {
  const fallback = candidates[0];
  console.log(`No agent skill directories found — using ${fallback.dir} (${fallback.who}).`);
  targets = [fallback];
}

// --------------------------------------------------------------- install ---
const EXCLUDE = new Set([".git", "sandbox", "node_modules", "__pycache__"]);
const samePlace = (a, b) => {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
};

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

console.log(`Installing ${NAME} from ${skillRoot}\n`);
const installed = [];
for (const t of targets) {
  const dest = path.join(t.dir, NAME);
  if (samePlace(skillRoot, dest)) {
    console.log(`  – ${dest}  (this IS the source copy — skipped)`);
    continue;
  }
  const existed = fs.existsSync(dest);
  try {
    fs.mkdirSync(t.dir, { recursive: true });
    copyDir(skillRoot, dest);
    installed.push(dest);
    console.log(`  ✓ ${dest}  (${existed ? "updated" : "installed"})  [${t.who}]`);
  } catch (e) {
    console.error(`  ✗ ${dest}  FAILED: ${e.message}`);
  }
}
if (!installed.length) {
  console.error("\nNothing was installed (source == target, or all targets failed).");
  process.exit(1);
}

// --------------------------------------------------------------- verify ----
console.log("\nVerifying with doctor...\n");
const isPy = process.argv[1]?.endsWith(".py");
const doctorBin = isPy ? "python3" : process.execPath;
const doctorScript = path.join(path.dirname(installed[0]), NAME, "scripts", isPy ? "doctor.py" : "doctor.mjs");
const probe = spawnSync(doctorBin, [doctorScript, "--json", "--timeout", "8"], { encoding: "utf8" });
let summaryLine = "doctor could not run — run it manually: node scripts/doctor.mjs";
if (probe.status === 0 || probe.status === 1) {
  try {
    const d = JSON.parse(probe.stdout);
    const ok = d.engines.filter((e) => e.status === "OK").map((e) => e.engine);
    const failed = d.engines.filter((e) => e.status === "FAIL").map((e) => e.engine);
    const skipped = d.engines.filter((e) => e.status === "SKIP").length;
    summaryLine = `engines OK: ${ok.join(", ") || "none"}` +
      (failed.length ? ` | FAILED: ${failed.join(", ")} (other engines cover them; see README Troubleshooting)` : "") +
      ` | skipped (no key): ${skipped}`;
  } catch { /* keep default summary line */ }
} else if (probe.error) {
  summaryLine = `doctor did not start: ${probe.error.message}`;
}
console.log(`  ${summaryLine}\n`);

// ------------------------------------------------------------ next steps ---
console.log(`Done. Now just talk to your agent — no configuration needed:
  "帮我查一下 rust async runtime 的最新资料"
  "search for the latest webgpu news"
  "读一下这个网页的内容: https://..."

Optional upgrades (never required): set BRAVE_API_KEY, TAVILY_API_KEY,
SERPER_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, BOCHA_API_KEY, METASO_API_KEY,
LINKUP_API_KEY, or OLLAMA_API_KEY — engines join automatically.
Troubleshooting: README "Troubleshooting" section, or node scripts/doctor.mjs`);
