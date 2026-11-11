/**
 * Extra search providers — the key-gated half of the catalogue.
 *
 * Every engine here needs an API key; without one it reports SKIP in doctor and
 * never runs. They are grouped by the shape of their API so the boilerplate
 * stays small:
 *
 *   - "organic"  GET/POST -> { organic_results: [...] }      (Google-shaped)
 *   - "results"  GET/POST -> { results: [...] }              (most modern APIs)
 *   - "walk"     unknown/agentic shape -> walk the JSON for url-bearing objects
 *
 * Contracts were taken from the provider implementations in pi-web-access
 * (the built-in web_search tool) so the request bodies match what actually
 * works. Endpoints and auth styles are per provider; see each entry.
 *
 * NOTE: none of these can be exercised without the matching key, so they are
 * implemented but unverified against the live API. Each one fails with a clear
 * "key not set" / "auth rejected" message rather than crashing.
 */

const MIN_TIMEOUT = 12000;

export function buildExtraEngines({ fetchText, parseJson }) {
  const request = async (url, { method = "POST", headers = {}, body, timeout = MIN_TIMEOUT } = {}) => {
    const res = await fetchText(url, {
      method,
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      timeout: Math.max(timeout, MIN_TIMEOUT),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`auth rejected (HTTP ${res.status}) — check the API key`);
    if (res.status === 429) throw new Error("rate limit (HTTP 429) — retry later or raise the plan");
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 120)}`);
    return parseJson(res.body);
  };

  const trim = (s, n = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

  // Pick title/url/snippet out of the shapes we see in the wild.
  const normalize = (item) => {
    if (!item || typeof item !== "object") return null;
    const url = item.url || item.link || item.href || item.source_url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
    const title = item.title || item.name || item.heading || url;
    const snippet = item.snippet || item.description || item.content || item.summary || item.excerpt || "";
    return { title: trim(title, 200), url, snippet: trim(snippet) };
  };

  // Depth-limited walk for providers whose envelope we cannot pin down.
  const walk = (node, out, limit, depth = 0) => {
    if (out.length >= limit || depth > 6 || node == null) return out;
    if (Array.isArray(node)) {
      for (const v of node) walk(v, out, limit, depth + 1);
      return out;
    }
    if (typeof node !== "object") return out;
    const item = normalize(node);
    if (item) { out.push(item); return out; }
    for (const v of Object.values(node)) walk(v, out, limit, depth + 1);
    return out;
  };

  const collect = (items, ctx, mapper = normalize) => {
    const out = [];
    for (const raw of items || []) {
      const r = mapper(raw);
      if (r) out.push(r);
      if (out.length >= ctx.n) break;
    }
    if (out.length === 0) throw new Error("no results parsed");
    return out;
  };

  const organicOf = (data) => data?.organic_results || data?.organic || data?.results || [];

  const engines = {
    // ── Google-shaped SERP resellers ─────────────────────────────────────
    serpapi: {
      key: "SERPAPI_API_KEY",
      fn: async (ctx) => {
        const p = new URLSearchParams({
          engine: "google", q: ctx.query, num: String(Math.min(ctx.n, 10)),
          api_key: process.env.SERPAPI_API_KEY,
        });
        const data = await request(`https://serpapi.com/search.json?${p}`, { method: "GET" });
        return collect(organicOf(data), ctx);
      },
    },
    serpbase: {
      key: "SERPBASE_API_KEY",
      fn: async (ctx) => {
        const p = new URLSearchParams({ q: ctx.query, api_key: process.env.SERPBASE_API_KEY });
        const data = await request(`https://api.serpbase.dev/google/search?${p}`, { method: "GET" });
        return collect(organicOf(data), ctx);
      },
    },
    searchapi: {
      key: "SEARCHAPI_API_KEY",
      fn: async (ctx) => {
        const p = new URLSearchParams({
          engine: "google", q: ctx.query, num: String(Math.min(ctx.n, 10)),
          api_key: process.env.SEARCHAPI_API_KEY,
        });
        const data = await request(`https://www.searchapi.io/api/v1/search?${p}`, { method: "GET" });
        return collect(organicOf(data), ctx);
      },
    },
    serply: {
      key: "SERPLY_API_KEY",
      fn: async (ctx) => {
        const p = new URLSearchParams({ q: ctx.query, num: String(Math.min(ctx.n, 10)) });
        const data = await request(`https://api.serply.io/v1/search?${p}`, {
          method: "GET", headers: { "x-api-key": process.env.SERPLY_API_KEY },
        });
        return collect(organicOf(data), ctx);
      },
    },
    xcrawl: {
      key: "XCRAWL_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://run.xcrawl.com/v1/serp", {
          headers: { authorization: `Bearer ${process.env.XCRAWL_API_KEY}` },
          body: { query: ctx.query, num_results: Math.min(ctx.n, 10) },
        });
        return collect(organicOf(data), ctx);
      },
    },

    // ── Modern "results[]" APIs ──────────────────────────────────────────
    kagi: {
      key: "KAGI_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://kagi.com/api/v1/search", {
          headers: { authorization: `Bearer ${process.env.KAGI_API_KEY}` },
          body: { query: ctx.query, limit: Math.min(ctx.n, 10) },
        });
        return collect(walk(data, [], ctx.n), ctx, (x) => x);
      },
    },
    serpdive: {
      key: "SERPDIVE_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.serpdive.com/v1/search", {
          headers: { authorization: `Bearer ${process.env.SERPDIVE_API_KEY}` },
          body: { query: ctx.query, max_results: Math.min(ctx.n, 10) },
        });
        return collect(data?.results || [], ctx);
      },
    },
    valyu: {
      key: "VALYU_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.valyu.ai/v1/search", {
          headers: { authorization: `Bearer ${process.env.VALYU_API_KEY}` },
          body: { query: ctx.query, max_num_results: Math.min(ctx.n, 10) },
        });
        return collect(data?.results || data?.data || [], ctx);
      },
    },
    you: {
      key: "YOU_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://ydc-index.io/v1/search", {
          headers: { "x-api-key": process.env.YOU_API_KEY },
          body: { query: ctx.query, count: Math.min(ctx.n, 10) },
        });
        return collect(walk(data, [], ctx.n), ctx, (x) => x);
      },
    },
    jina: {
      key: "JINA_API_KEY",
      fn: async (ctx) => {
        const p = new URLSearchParams({ q: ctx.query, count: String(Math.min(ctx.n, 10)) });
        const data = await request(`https://s.jina.ai/?${p}`, {
          method: "GET", headers: { authorization: `Bearer ${process.env.JINA_API_KEY}` },
        });
        return collect(data?.data || [], ctx);
      },
    },
    search1api: {
      key: "SEARCH1API_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.search1api.com/search", {
          headers: { authorization: `Bearer ${process.env.SEARCH1API_API_KEY}` },
          body: { query: ctx.query, max_results: Math.min(ctx.n, 10) },
        });
        return collect(data?.results || [], ctx);
      },
    },
    searchinfinity: {
      key: "SEARCHINFINITY_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://torchlight.byteintlapi.com/search_api/web_search", {
          headers: { authorization: `Bearer ${process.env.SEARCHINFINITY_API_KEY}` },
          body: { query: ctx.query, count: Math.min(ctx.n, 10) },
        });
        return collect(walk(data, [], ctx.n), ctx, (x) => x);
      },
    },
    querit: {
      key: "QUERIT_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.querit.ai/v1/search", {
          headers: { authorization: `Bearer ${process.env.QUERIT_API_KEY}` },
          body: { query: ctx.query, max_results: Math.min(ctx.n, 10) },
        });
        return collect(data?.results || data?.data || [], ctx);
      },
    },
    sofya: {
      key: "SOFYA_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://sofya.co/v1/search", {
          headers: { authorization: `Bearer ${process.env.SOFYA_API_KEY}` },
          body: { query: ctx.query, max_results: Math.min(ctx.n, 10) },
        });
        return collect(data?.results || [], ctx);
      },
    },
    outcrawl: {
      key: "OUTCRAWL_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.outcrawl.ai/v1/search", {
          headers: { authorization: `Bearer ${process.env.OUTCRAWL_API_KEY}` },
          body: { query: ctx.query, max_results: Math.min(ctx.n, 10) },
        });
        return collect(data?.results || data?.data || [], ctx);
      },
    },
    ceramic: {
      key: "CERAMIC_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.ceramic.ai/search", {
          headers: { authorization: `Bearer ${process.env.CERAMIC_API_KEY}` },
          body: { query: ctx.query, max_results: Math.min(ctx.n, 10) },
        });
        return collect(data?.results || data?.result?.results || [], ctx);
      },
    },
    tinyfish: {
      key: "TINYFISH_API_KEY",
      fn: async (ctx) => {
        const p = new URLSearchParams({ query: ctx.query, num_results: String(Math.min(ctx.n, 10)) });
        const data = await request(`https://api.search.tinyfish.ai?${p}`, {
          method: "GET", headers: { "x-api-key": process.env.TINYFISH_API_KEY },
        });
        return collect(data?.results || [], ctx);
      },
    },
    tabstack: {
      key: "TABSTACK_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.tabstack.ai/v1/research", {
          headers: { authorization: `Bearer ${process.env.TABSTACK_API_KEY}` },
          body: { query: ctx.query, max_results: Math.min(ctx.n, 10) },
        });
        return collect(walk(data, [], ctx.n), ctx, (x) => x);
      },
    },
    parallel: {
      key: "PARALLEL_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.parallel.ai/v1/search", {
          headers: { authorization: `Bearer ${process.env.PARALLEL_API_KEY}` },
          body: { objective: ctx.query, search_queries: [ctx.query], max_results: Math.min(ctx.n, 10) },
        });
        return collect(data?.results || [], ctx, (r) => ({
          title: trim(r.title || r.url, 200),
          url: r.url,
          snippet: trim(Array.isArray(r.excerpts) ? r.excerpts.join(" ") : r.excerpt || r.content),
        }));
      },
    },
    deepseek: {
      key: "DEEPSEEK_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.deepseek.com/v1/tools/search", {
          headers: { authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
          body: { query: ctx.query, count: Math.min(ctx.n, 10) },
        });
        return collect(data?.results || data?.data || [], ctx);
      },
    },
    kimi: {
      key: "KIMI_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.kimi.com/coding/v1/search", {
          headers: { authorization: `Bearer ${process.env.KIMI_API_KEY}` },
          body: { text_query: ctx.query },
        });
        return collect(walk(data, [], ctx.n), ctx, (x) => x);
      },
    },
    perplexity: {
      key: "PERPLEXITY_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.perplexity.ai/search", {
          headers: { authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` },
          body: { query: ctx.query, max_results: Math.min(ctx.n, 10) },
        });
        return collect(data?.results || data?.data || [], ctx);
      },
    },

    // ── LLM-native search (the model does the searching) ─────────────────
    openai: {
      key: "OPENAI_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.openai.com/v1/responses", {
          headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: {
            model: process.env.OPENAI_SEARCH_MODEL || "gpt-4o-mini",
            tools: [{ type: "web_search_preview" }],
            input: ctx.query,
          },
          timeout: 45000,
        });
        return collect(walk(data, [], ctx.n), ctx, (x) => x);
      },
    },
    xai: {
      key: "XAI_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.x.ai/v1/responses", {
          headers: { authorization: `Bearer ${process.env.XAI_API_KEY}` },
          body: {
            model: process.env.XAI_SEARCH_MODEL || "grok-4",
            tools: [{ type: "web_search" }],
            input: ctx.query,
          },
          timeout: 45000,
        });
        return collect(walk(data, [], ctx.n), ctx, (x) => x);
      },
    },
    gemini: {
      key: "GEMINI_API_KEY",
      fn: async (ctx) => {
        const model = process.env.GEMINI_SEARCH_MODEL || "gemini-2.0-flash";
        const data = await request(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            body: { contents: [{ parts: [{ text: ctx.query }] }], tools: [{ google_search: {} }] },
            timeout: 45000,
          },
        );
        return collect(walk(data, [], ctx.n), ctx, (x) => x);
      },
    },
    mistral: {
      key: "MISTRAL_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://api.mistral.ai/v1/conversations", {
          headers: { authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
          body: {
            model: process.env.MISTRAL_SEARCH_MODEL || "mistral-medium-latest",
            inputs: [{ role: "user", content: ctx.query }],
            tools: [{ type: "web_search" }],
          },
          timeout: 45000,
        });
        return collect(walk(data, [], ctx.n), ctx, (x) => x);
      },
    },

    // ── MCP-shaped (tools/call over JSON-RPC) ────────────────────────────
    baizhi: {
      key: "BAIZHI_API_KEY",
      fn: async (ctx) => {
        const data = await request("https://agent-toolkit.app.baizhi.cloud/mcp", {
          headers: { authorization: `Bearer ${process.env.BAIZHI_API_KEY}` },
          body: {
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "web_search", arguments: { query: ctx.query, count: Math.min(ctx.n, 10) } },
          },
        });
        return collect(walk(data, [], ctx.n), ctx, (x) => x);
      },
    },
    zai: {
      key: "ZAI_API_KEY",
      fn: async (ctx) => {
        const base = process.env.ZAI_BASE_URL || "https://api.z.ai/api/mcp/web_search_prime/mcp";
        const data = await request(base, {
          headers: { authorization: `Bearer ${process.env.ZAI_API_KEY}` },
          body: {
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "web_search_prime", arguments: { search_query: ctx.query } },
          },
        });
        return collect(walk(data, [], ctx.n), ctx, (x) => x);
      },
    },

    // ── Self-hosted / account-scoped ─────────────────────────────────────
    ninerouter: {
      key: "NINEROUTER_BASE_URL",
      fn: async (ctx) => {
        const base = (process.env.NINEROUTER_BASE_URL || "").replace(/\/+$/, "");
        if (!base) throw new Error("NINEROUTER_BASE_URL not set (e.g. https://your-router/v1)");
        const headers = process.env.NINEROUTER_API_KEY ? { authorization: `Bearer ${process.env.NINEROUTER_API_KEY}` } : {};
        const data = await request(`${base}/search`, { headers, body: { query: ctx.query, limit: Math.min(ctx.n, 10) } });
        return collect(data?.results || data?.data || [], ctx);
      },
    },
    cloudflare: {
      key: "CLOUDFLARE_API_TOKEN",
      fn: async (ctx) => {
        const account = process.env.CLOUDFLARE_ACCOUNT_ID;
        if (!account) throw new Error("CLOUDFLARE_ACCOUNT_ID not set");
        const data = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/search`, {
          headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
          body: { query: ctx.query, max_results: Math.min(ctx.n, 10) },
        });
        return collect(data?.result || data?.results || [], ctx);
      },
    },
    brightdata: {
      key: "BRIGHTDATA_API_KEY",
      fn: async (ctx) => {
        const zone = process.env.BRIGHTDATA_ZONE;
        if (!zone) throw new Error("BRIGHTDATA_ZONE not set");
        const p = new URLSearchParams({ q: ctx.query, zone, format: "json" });
        const data = await request(`https://api.brightdata.com/request?${p}`, {
          headers: { authorization: `Bearer ${process.env.BRIGHTDATA_API_KEY}` },
        });
        return collect(organicOf(data), ctx);
      },
    },
  };

  // An explicitly requested engine without its key must say so, not 401.
  for (const [name, e] of Object.entries(engines)) {
    const inner = e.fn;
    engines[name] = {
      ...e,
      fn: async (ctx) => {
        if (e.key && !process.env[e.key]) {
          throw new Error(`${e.key} not set — this engine needs an API key (see README for the signup link)`);
        }
        return inner(ctx);
      },
    };
  }
  return engines;
}

export const EXTRA_ENGINE_KEYS = [
  "SERPAPI_API_KEY", "SERPBASE_API_KEY", "SEARCHAPI_API_KEY", "SERPLY_API_KEY", "XCRAWL_API_KEY",
  "KAGI_API_KEY", "SERPDIVE_API_KEY", "VALYU_API_KEY", "YOU_API_KEY", "JINA_API_KEY",
  "SEARCH1API_API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "SOFYA_API_KEY",
  "OUTCRAWL_API_KEY", "CERAMIC_API_KEY", "TINYFISH_API_KEY", "TABSTACK_API_KEY",
  "PARALLEL_API_KEY", "DEEPSEEK_API_KEY", "KIMI_API_KEY", "PERPLEXITY_API_KEY",
  "OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY",
  "BAIZHI_API_KEY", "ZAI_API_KEY", "NINEROUTER_BASE_URL", "CLOUDFLARE_API_TOKEN",
  "BRIGHTDATA_API_KEY",
];
