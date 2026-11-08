#!/usr/bin/env node
/**
 * easy-websearch MCP Server
 * Protocol: JSON-RPC 2.0 over stdio (NDJSON)
 * Zero npm dependencies. Node >= 18.
 *
 * Tools:
 *   web_search      — multi-engine search with RRF fusion
 *   read_page       — URL → Markdown page reader
 *   deep_research   — multi-round evidence collector
 *   engine_status   — engine health check
 *
 * Setup (Claude Desktop / Cursor / any MCP client):
 *   { "mcpServers": { "easy-websearch": { "command": "node", "args": ["<path>/server.mjs"] } } }
 *
 * Or via npx: { "command": "npx", "args": ["-y", "easy-websearch-mcp"] }
 */
import readline from "node:readline";
import {
  ENGINES, availableEngines, fetchText, stripTags,
  normalizeUrl, setForceDirect,
} from "./scripts/search.mjs";

// ────────────────────────────────────────── state ──
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const SERVER_INFO = { name: "easy-websearch", version: pkg.version };
const PROTOCOL_VERSION = "2024-11-05";

// ─────────────────────────────── tool definitions ──
const TOOLS = [
  {
    name: "web_search",
    description:
      "Multi-engine web search with Reciprocal Rank Fusion. Searches 15+ engines " +
      "in parallel (DuckDuckGo, Bing, Baidu, Sogou, 360, Wikipedia, StackExchange, " +
      "HN, GitHub, Juejin, arXiv, Mwmbl, CSDN, OpenAlex, Crossref, PubMed, " +
      "HuggingFace — plus 9 more with API keys). Returns ranked results with " +
      "per-engine attribution. Works with zero API keys.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        lang: { type: "string", enum: ["zh", "en"], description: "Language/region boost" },
        n: { type: "number", description: "Max results (default 10)", default: 10 },
        engines: { type: "string", description: "Comma-separated engine names to restrict/enable" },
        days: { type: "number", description: "Time window in days" },
        direct: { type: "boolean", description: "Bypass proxy for all engines" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_page",
    description:
      "Read a URL as Markdown. Fallback chain: direct fetch → Firecrawl (if key) → " +
      "r.jina.ai reader. Returns the page content as clean Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to read" },
        max_chars: { type: "number", description: "Max content length (default 8000)", default: 8000 },
      },
      required: ["url"],
    },
  },
  {
    name: "deep_research",
    description:
      "Multi-round evidence collector. Decomposes the question into sub-queries, " +
      "runs parallel searches, fetches top pages, and outputs a structured evidence " +
      "pack with cross-hit annotations. The agent reads this and writes the cited answer.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The research question" },
        queries: { type: "string", description: "Comma-separated sub-queries (agent-provided, best quality)" },
        depth: { type: "number", description: "Pages to fetch per sub-query (default 2)", default: 2 },
        lang: { type: "string", enum: ["zh", "en"], description: "Language boost" },
      },
      required: ["question"],
    },
  },
  {
    name: "engine_status",
    description: "Engine health check — which engines are reachable, which keys are configured, cooldown state.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─────────────────────────────── tool implementations ──
async function toolWebSearch(args) {
  const { query, lang, n = 10, engines: engineFilter, days = 0, direct = false } = args;
  if (direct) setForceDirect(true);

  const ctx = {
    query, n, days: days || 0, lang: lang || "", timeout: 10,
    engines: "", json: true, site: [], excludeSite: [],
  };
  const engineNames = engineFilter
    ? engineFilter.split(",").map(s => s.trim()).filter(n => ENGINES[n])
    : availableEngines();

  const statuses = await Promise.all(engineNames.map(async (name) => {
    const e = ENGINES[name];
    const fn = typeof e === "function" ? e : e.fn;
    try {
      const results = await fn({ ...ctx, query });
      return { name, ok: true, results };
    } catch (err) {
      return { name, ok: false, results: [], error: err.message };
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
  const fused = [...byUrl.values()].sort((a, b) => b.score - a.score).slice(0, n);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        query,
        engines: statuses.map(({ name, ok, error }) => ({ name, ok, ...(error && { error }) })),
        results: fused.map((r, i) => ({
          rank: i + 1, title: r.title, url: r.url, snippet: r.snippet,
          score: +r.score.toFixed(4), engines: r.engines,
        })),
      }, null, 2),
    }],
  };
}

async function toolReadPage(args) {
  const { url, max_chars = 8000 } = args;
  const { status, body } = await fetchText(url, { timeout: 15000 });
  if (status !== 200 || body.length < 200) {
    // r.jina.ai fallback
    const jina = await fetchText(`https://r.jina.ai/${url}`, { timeout: 15000, headers: { accept: "text/plain" } });
    if (jina.status === 200 && jina.body.trim().length > 100) {
      return { content: [{ type: "text", text: jina.body.slice(0, max_chars) }] };
    }
    return { content: [{ type: "text", text: `Failed: HTTP ${status} (direct) / HTTP ${jina.status} (reader)` }] };
  }
  const text = stripTags(body).replace(/\s+/g, " ").trim();
  return { content: [{ type: "text", text: text.slice(0, max_chars) }] };
}

async function toolDeepResearch(args) {
  const { question, queries, depth = 2, lang } = args;
  const maxSearches = 8, maxFetches = 12;
  const subQueries = queries
    ? queries.split(",").map(s => s.trim()).filter(Boolean).slice(0, 6)
    : [question, question + " tutorial", question + " best practices"];

  let budget = { searches: 0, fetches: 0 };
  const evidence = [];
  const urlHits = new Map();

  async function doSearch(subQuery) {
    if (budget.searches >= maxSearches) return null;
    budget.searches++;
    const ctx = { query: subQuery, n: 5, days: 0, lang: lang || "", timeout: 10, engines: "", json: true, site: [], excludeSite: [] };
    const engineNames = availableEngines("");
    const usable = engineNames.filter(name => {
      const e = ENGINES[name];
      if (!e) return false;
      if (typeof e === "object") {
        if (e.key && !process.env[e.key] && !e.optionalKey) return false;
        if (e.backup || e.auto) return false;
      }
      return true;
    });
    const statuses = await Promise.all(usable.map(async (name) => {
      const e = ENGINES[name];
      const fn = typeof e === "function" ? e : e.fn;
      try {
        const results = await fn({ ...ctx, query: subQuery });
        return { name, ok: true, results };
      } catch (err) {
        return { name, ok: false, results: [], error: err.message };
      }
    }));

    const byUrl = new Map();
    for (const s of statuses.filter(s => s.ok)) {
      s.results.forEach((r, idx) => {
        const key = normalizeUrl(r.url);
        if (!byUrl.has(key)) byUrl.set(key, { ...r, score: 0, engines: [] });
        const item = byUrl.get(key);
        item.score += 1 / (60 + idx + 1);
        if (!item.engines.includes(s.name)) item.engines.push(s.name);
      });
    }
    const fused = [...byUrl.values()].sort((a, b) => b.score - a.score).slice(0, 8);
    for (const r of fused) {
      const norm = normalizeUrl(r.url);
      if (!urlHits.has(norm)) urlHits.set(norm, { engines: new Set(), count: 0 });
      urlHits.get(norm).count++;
      for (const e of r.engines) urlHits.get(norm).engines.add(e);
    }
    return { sub_query: subQuery, results: fused, engines_used: statuses.map(s => s.name) };
  }

  const searchResults = (await Promise.all(subQueries.map(doSearch))).filter(Boolean);

  // Fetch top pages
  const fetchTargets = [];
  const seen = new Set();
  for (const sr of searchResults) {
    for (const r of sr.results.slice(0, depth)) {
      const norm = normalizeUrl(r.url);
      if (!seen.has(norm)) { seen.add(norm); fetchTargets.push(r.url); }
    }
  }
  const fetchResults = await Promise.all(
    fetchTargets.slice(0, maxFetches).map(async (url) => {
      budget.fetches++;
      try {
        const { status, body } = await fetchText(url, { timeout: 15000 });
        if (status === 200 && body.length > 200) {
          const text = stripTags(body).replace(/\s+/g, " ").trim();
          return { url, ok: true, excerpt: text.slice(0, 2000) };
        }
      } catch { /* skip */ }
      return null;
    })
  );
  const fetchByUrl = new Map(fetchResults.filter(Boolean).map(f => [f.url, f]));
  for (const sr of searchResults) {
    for (const r of sr.results) {
      const f = fetchByUrl.get(r.url);
      if (f?.ok) r.fetched = true;
    }
  }

  const crossHits = [...urlHits.entries()]
    .map(([url, h]) => ({ url, engines: [...h.engines], count: h.count }))
    .filter(h => h.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  const evidencePack = {
    question,
    sub_queries: subQueries,
    evidence: searchResults,
    cross_hits: crossHits,
    budget_used: budget,
  };

  return {
    content: [{
      type: "text",
      text: JSON.stringify(evidencePack, null, 2),
    }],
  };
}

function toolEngineStatus() {
  const engines = Object.keys(ENGINES).map((name) => {
    const e = ENGINES[name];
    const key = typeof e === "object" ? e.key : null;
    const tier = typeof e === "object"
      ? (e.backup ? "backup" : e.auto ? "auto" : key ? "keyed" : "baseline")
      : "baseline";
    return {
      name, tier,
      key_configured: key ? Boolean(process.env[key]) : true,
      key_env: key || null,
    };
  });
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ total: engines.length, engines }, null, 2),
    }],
  };
}

const TOOL_HANDLERS = {
  web_search: toolWebSearch,
  read_page: toolReadPage,
  deep_research: toolDeepResearch,
  engine_status: toolEngineStatus,
};

// ─────────────────────────────── MCP protocol ──
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line.trim()); } catch { return; }
  if (!msg || msg.jsonrpc !== "2.0") return;

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
  } else if (msg.method === "notifications/initialized") {
    // no response needed
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === "tools/call") {
    const { name, arguments: toolArgs } = msg.params || {};
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      return;
    }
    handler(toolArgs || {}).then(
      (result) => send({ jsonrpc: "2.0", id: msg.id, result }),
      (err) => send({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
      })
    );
  } else if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});

rl.on("close", () => process.exit(0));
