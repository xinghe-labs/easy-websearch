#!/usr/bin/env node
/**
 * easy-websearch research — multi-round evidence collector.
 * Zero npm dependencies. Node >= 18.
 *
 * Collects structured evidence (NOT a summary — the agent writes the answer):
 *   1. Decomposes the question into sub-queries (agent-provided or rule-based)
 *   2. Runs parallel searches across the engine pool
 *   3. Fetches top pages per sub-query (title + first chars as evidence)
 *   4. Compiles a cross-hit annotated evidence pack
 *
 * Usage:
 *   node scripts/research.mjs "question" [options]
 *
 * Options:
 *   --queries "q1,q2,…"   explicit sub-queries (agent-provided, best quality)
 *   --depth 2             pages to fetch per sub-query (default 2)
 *   --lang zh|en          language boost
 *   --max-searches 8      search budget cap (default 8)
 *   --max-fetches 12      fetch budget cap (default 12)
 *   --timeout 8           per-engine timeout (seconds)
 *   --json                machine-readable output
 *   --direct              bypass proxy for all requests
 */
import {
  ENGINES, availableEngines, fetchText, stripTags, normalizeUrl,
} from "./search.mjs";


// ────────────────────────────────────────────── CLI ──
const argv = process.argv.slice(2);
const flags = { queries: "", depth: 2, lang: "", maxSearches: 8, maxFetches: 12, timeout: 8, json: false, direct: false };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--queries") flags.queries = argv[++i] || "";
  else if (a === "--depth") flags.depth = parseInt(argv[++i], 10) || 2;
  else if (a === "--lang") flags.lang = argv[++i] || "";
  else if (a === "--max-searches") flags.maxSearches = parseInt(argv[++i], 10) || 8;
  else if (a === "--max-fetches") flags.maxFetches = parseInt(argv[++i], 10) || 12;
  else if (a === "--timeout") flags.timeout = parseInt(argv[++i], 10) || 8;
  else if (a === "--json") flags.json = true;
  else if (a === "--direct") flags.direct = true;
  else rest.push(a);
}
const question = rest.join(" ").trim();
if (!question) {
  console.error('Usage: node scripts/research.mjs "question" [--queries "q1,q2,q3"] [--depth 2] [--json]');
  process.exit(2);
}

if (flags.direct || process.env.EASY_WEB_SEARCH_DIRECT === "1") setForceDirect(true);


// ─────────────────────────────── sub-query generation ──
function defaultSubQueries(q) {
  const subs = [q];
  const cjk = /[\u4e00-\u9fa5]/.test(q);
  // English keyword extraction for cross-language coverage
  const ascii = q.match(/[A-Za-z][A-Za-z0-9+#./ _-]{2,}/g);
  if (ascii && ascii.length && !/^[a-zA-Z0-9\s]+$/.test(q.trim())) {
    const en = ascii.map(s => s.trim()).filter(s => s.length >= 3);
    if (en.length) subs.push(en.join(" "));
  }
  // CJK → EN or EN → CJK variant
  if (cjk) {
    // Add a "什么/如何" variant for Chinese queries
    if (!/什么|如何|怎么|为什么/.test(q)) subs.push(q + " 是什么");
    if (!/教程|入门|使用/.test(q)) subs.push(q + " 教程");
  } else {
    if (!/tutorial|how to|guide/.test(q.toLowerCase())) subs.push(q + " tutorial");
    if (!/best|comparison|review/.test(q.toLowerCase())) subs.push(q + " best practices");
  }
  return subs.slice(0, 6);
}

const subQueries = flags.queries
  ? flags.queries.split(",").map(s => s.trim()).filter(Boolean).slice(0, 6)
  : defaultSubQueries(question);

const budget = { searches: 0, fetches: 0 };
const evidence = [];       // per-sub-query results
const urlHits = new Map(); // url → { engines: Set, count }

// ─────────────────────────────────────────── searching ──
async function runSearch(subQuery) {
  if (budget.searches >= flags.maxSearches) return null;
  budget.searches++;
  const engineCtx = { query: subQuery, n: 5, days: 0, lang: flags.lang, timeout: flags.timeout, engines: "", json: true, site: [], excludeSite: [], direct: flags.direct, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.endsWith('_API_KEY') || k === 'SEARXNG_BASE_URL')) };
  const engines = availableEngines("");
  const usable = engines.filter(name => {
    const e = ENGINES[name];
    if (!e) return false;
    if (typeof e === "object") {
      if (e.key && !process.env[e.key] && !e.optionalKey) return false;
      if (e.backup || e.auto) return false;
    }
    return true;
  });
  if (!usable.length) return { subQuery, results: [], engines_used: [] };

  const statuses = await Promise.all(usable.map(async (name) => {
    const e = ENGINES[name];
    const fn = typeof e === "function" ? e : e.fn;
    const t0 = Date.now();
    try {
      const results = await fn(engineCtx);
      return { name, ok: true, results, ms: Date.now() - t0 };
    } catch (err) {
      return { name, ok: false, results: [], ms: Date.now() - t0, error: err.message };
    }
  }));

  // RRF fusion
  const byUrl = new Map();
  for (const s of statuses.filter(s => s.ok)) {
    s.results.forEach((r, idx) => {
      const key = normalizeUrl(r.url);
      if (!byUrl.has(key)) byUrl.set(key, { ...r, score: 0, engines: [] });
      const item = byUrl.get(key);
      item.score += 1 / (60 + idx + 1);
      if (!item.engines.includes(s.name)) item.engines.push(s.name);
      if (item.snippet.length < (r.snippet || "").length) item.snippet = r.snippet;
    });
  }
  const fused = [...byUrl.values()].sort((a, b) => b.score - a.score).slice(0, 8);
  for (const r of fused) {
    const norm = normalizeUrl(r.url);
    if (!urlHits.has(norm)) urlHits.set(norm, { engines: new Set(), count: 0 });
    const h = urlHits.get(norm);
    h.count++;
    for (const e of r.engines) h.engines.add(e);
  }
  return { subQuery, results: fused, engines_used: statuses.map(s => s.name) };
}

// ─────────────────────────────────────────── fetching ──
async function fetchPage(url) {
  if (budget.fetches >= flags.maxFetches) return null;
  budget.fetches++;
  try {
    const { status, body } = await fetchText(url, { timeout: Math.max(flags.timeout * 1.5, 12) });
    if (status !== 200 || body.length < 200) return { url, ok: false, reason: `HTTP ${status}` };
    const text = stripTags(body).replace(/\s+/g, " ").trim();
    return { url, ok: true, chars: text.length, excerpt: text.slice(0, 2000) };
  } catch (e) {
    return { url, ok: false, reason: e.message };
  }
}

// ─────────────────────────────────────────── main loop ──
// Phase 1: parallel searches
const searchPromises = subQueries.map(q => runSearch(q));
const searchResults = await Promise.all(searchPromises);

// Phase 2: pick top URLs per sub-query → fetch
const fetchTargets = [];
const seen = new Set();
for (const sr of searchResults.filter(Boolean)) {
  for (const r of sr.results.slice(0, flags.depth)) {
    const norm = normalizeUrl(r.url);
    if (seen.has(norm)) continue;
    seen.add(norm);
    fetchTargets.push(r.url);
  }
}
const fetchResults = await Promise.all(fetchTargets.slice(0, flags.maxFetches).map(fetchPage));

// Phase 3: attach fetch results to evidence
const fetchByUrl = new Map(fetchResults.filter(Boolean).map(f => [f.url, f]));
for (const sr of searchResults.filter(Boolean)) {
  for (const r of sr.results) {
    const f = fetchByUrl.get(r.url);
    if (f?.ok) { r.fetched = true; r.content_excerpt = f.excerpt; }
  }
  evidence.push(sr);
}

// Phase 4: cross-hit analysis
const crossHits = [...urlHits.entries()]
  .map(([url, h]) => ({ url, engines: [...h.engines], count: h.count }))
  .filter(h => h.count >= 2)
  .sort((a, b) => b.count - a.count)
  .slice(0, 15);

// ─────────────────────────────────────────── output ──
const evidencePack = {
  question,
  sub_queries: subQueries,
  evidence,
  cross_hits: crossHits,
  budget_used: budget,
  coverage: {},
};

// noop removed

// (coverage: per-engine hit counts across all searches)
const engineCounts = {};
for (const sr of evidence) {
  for (const e of sr.engines_used || []) engineCounts[e] = (engineCounts[e] || 0) + 1;
}
evidencePack.coverage = engineCounts;

if (flags.json) {
  console.log(JSON.stringify(evidencePack, null, 2));
} else {
  console.log(`═══ research: ${question} ═══`);
  console.log(`子查询 ${subQueries.length} 个 · 搜索 ${budget.searches ?? budget.searches} 次 · 抓取 ${budget.fetches} 页 · 交叉命中 ${crossHits.length} 个 URL\n`);
  for (const sr of evidence) {
    console.log(`── ${sr.subQuery} ──`);
    for (const r of (sr.results || []).slice(0, 5)) {
      console.log(`  ${r.title}`);
      console.log(`    ${r.url}  [${r.engines.join(", ")}]${r.fetched ? " 📄已抓取" : ""}`);
      if (r.snippet) console.log(`    ${r.snippet.slice(0, 120)}`);
    }
  }
  if (crossHits.length) {
    console.log(`\n── 交叉命中（多引擎共同认可）──`);
    for (const c of crossHits.slice(0, 5)) console.log(`  ${c.count}× ${c.url}`);
  }
  console.log(`\n预算: 搜索 ${budget.searches}/${flags.maxSearches} · 抓取 ${budget.fetches}/${flags.maxFetches}`);
  console.log(`下一步: 将本证据包交给 agent 总结（结论需带 URL，冲突来源并列呈现）`);
}
