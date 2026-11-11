"""Extra search providers — the key-gated half of the catalogue.

Mirrors scripts/extra-engines.mjs. Every engine here needs an API key; without
one it reports SKIP in doctor and never runs.

Contracts were taken from the provider implementations in pi-web-access (the
built-in web_search tool) so the request bodies match what actually works.
None of these can be exercised without the matching key, so they are implemented
but unverified against the live API. Each one fails with a clear "key not set" /
"auth rejected" message rather than crashing.
"""
import json
import os
import re
import urllib.parse

MIN_TIMEOUT = 12


def _trim(value, limit=400):
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip()[:limit]


def _normalize(item):
    if not isinstance(item, dict):
        return None
    url = item.get("url") or item.get("link") or item.get("href") or item.get("source_url")
    if not isinstance(url, str) or not re.match(r"^https?://", url):
        return None
    title = item.get("title") or item.get("name") or item.get("heading") or url
    snippet = (item.get("snippet") or item.get("description") or item.get("content")
               or item.get("summary") or item.get("excerpt") or "")
    return {"title": _trim(title, 200), "url": url, "snippet": _trim(snippet)}


def _walk(node, out, limit, depth=0):
    if len(out) >= limit or depth > 6 or node is None:
        return out
    if isinstance(node, list):
        for value in node:
            _walk(value, out, limit, depth + 1)
        return out
    if not isinstance(node, dict):
        return out
    item = _normalize(node)
    if item:
        out.append(item)
        return out
    for value in node.values():
        _walk(value, out, limit, depth + 1)
    return out


def build_extra_engines(http_text, parse_json):
    def request(url, method="POST", headers=None, body=None, timeout=MIN_TIMEOUT):
        merged = {"accept": "application/json"}
        if body is not None:
            merged["content-type"] = "application/json"
        merged.update(headers or {})
        status, text = http_text(url, method=method, headers=merged,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 timeout=max(timeout, MIN_TIMEOUT))
        if status in (401, 403):
            raise RuntimeError(f"auth rejected (HTTP {status}) — check the API key")
        if status == 429:
            raise RuntimeError("rate limit (HTTP 429) — retry later or raise the plan")
        if status != 200:
            raise RuntimeError(f"HTTP {status}: {text[:120]}")
        return parse_json(text)

    def collect(items, ctx, mapper=_normalize):
        out = []
        for raw in items or []:
            mapped = mapper(raw)
            if mapped:
                out.append(mapped)
            if len(out) >= ctx["n"]:
                break
        if not out:
            raise RuntimeError("no results parsed")
        return out

    def organic_of(data):
        if not isinstance(data, dict):
            return []
        return (data.get("organic_results") or data.get("organic")
                or data.get("results") or [])

    def env(name):
        return os.environ.get(name) or ""

    def bearer(name):
        return {"authorization": f"Bearer {env(name)}"}

    engines = {
        # ── Google-shaped SERP resellers ────────────────────────────────
        "serpapi": {
            "key": "SERPAPI_API_KEY",
            "fn": lambda ctx: collect(organic_of(request(
                "https://serpapi.com/search.json?" + urllib.parse.urlencode({
                    "engine": "google", "q": ctx["query"], "num": min(ctx["n"], 10),
                    "api_key": env("SERPAPI_API_KEY")}), method="GET")), ctx),
        },
        "serpbase": {
            "key": "SERPBASE_API_KEY",
            "fn": lambda ctx: collect(organic_of(request(
                "https://api.serpbase.dev/google/search?" + urllib.parse.urlencode({
                    "q": ctx["query"], "api_key": env("SERPBASE_API_KEY")}), method="GET")), ctx),
        },
        "searchapi": {
            "key": "SEARCHAPI_API_KEY",
            "fn": lambda ctx: collect(organic_of(request(
                "https://www.searchapi.io/api/v1/search?" + urllib.parse.urlencode({
                    "engine": "google", "q": ctx["query"], "num": min(ctx["n"], 10),
                    "api_key": env("SEARCHAPI_API_KEY")}), method="GET")), ctx),
        },
        "serply": {
            "key": "SERPLY_API_KEY",
            "fn": lambda ctx: collect(organic_of(request(
                "https://api.serply.io/v1/search?" + urllib.parse.urlencode({
                    "q": ctx["query"], "num": min(ctx["n"], 10)}),
                method="GET", headers={"x-api-key": env("SERPLY_API_KEY")})), ctx),
        },
        "xcrawl": {
            "key": "XCRAWL_API_KEY",
            "fn": lambda ctx: collect(organic_of(request(
                "https://run.xcrawl.com/v1/serp",
                headers=bearer("XCRAWL_API_KEY"),
                body={"query": ctx["query"], "num_results": min(ctx["n"], 10)})), ctx),
        },
        # ── Modern results[] APIs ───────────────────────────────────────
        "kagi": {
            "key": "KAGI_API_KEY",
            "fn": lambda ctx: collect(_walk(request(
                "https://kagi.com/api/v1/search",
                headers=bearer("KAGI_API_KEY"),
                body={"query": ctx["query"], "limit": min(ctx["n"], 10)}), [], ctx["n"]), ctx,
                mapper=lambda x: x),
        },
        "serpdive": {
            "key": "SERPDIVE_API_KEY",
            "fn": lambda ctx: collect((request(
                "https://api.serpdive.com/v1/search",
                headers=bearer("SERPDIVE_API_KEY"),
                body={"query": ctx["query"], "max_results": min(ctx["n"], 10)}) or {}).get("results"), ctx),
        },
        "valyu": {
            "key": "VALYU_API_KEY",
            "fn": lambda ctx: collect((lambda d: d.get("results") or d.get("data") or [])(request(
                "https://api.valyu.ai/v1/search",
                headers=bearer("VALYU_API_KEY"),
                body={"query": ctx["query"], "max_num_results": min(ctx["n"], 10)})), ctx),
        },
        "you": {
            "key": "YOU_API_KEY",
            "fn": lambda ctx: collect(_walk(request(
                "https://ydc-index.io/v1/search",
                headers={"x-api-key": env("YOU_API_KEY")},
                body={"query": ctx["query"], "count": min(ctx["n"], 10)}), [], ctx["n"]), ctx,
                mapper=lambda x: x),
        },
        "jina": {
            "key": "JINA_API_KEY",
            "fn": lambda ctx: collect((request(
                "https://s.jina.ai/?" + urllib.parse.urlencode({
                    "q": ctx["query"], "count": min(ctx["n"], 10)}),
                method="GET", headers=bearer("JINA_API_KEY")) or {}).get("data"), ctx),
        },
        "search1api": {
            "key": "SEARCH1API_API_KEY",
            "fn": lambda ctx: collect((request(
                "https://api.search1api.com/search",
                headers=bearer("SEARCH1API_API_KEY"),
                body={"query": ctx["query"], "max_results": min(ctx["n"], 10)}) or {}).get("results"), ctx),
        },
        "searchinfinity": {
            "key": "SEARCHINFINITY_API_KEY",
            "fn": lambda ctx: collect(_walk(request(
                "https://torchlight.byteintlapi.com/search_api/web_search",
                headers=bearer("SEARCHINFINITY_API_KEY"),
                body={"query": ctx["query"], "count": min(ctx["n"], 10)}), [], ctx["n"]), ctx,
                mapper=lambda x: x),
        },
        "querit": {
            "key": "QUERIT_API_KEY",
            "fn": lambda ctx: collect((lambda d: d.get("results") or d.get("data") or [])(request(
                "https://api.querit.ai/v1/search",
                headers=bearer("QUERIT_API_KEY"),
                body={"query": ctx["query"], "max_results": min(ctx["n"], 10)})), ctx),
        },
        "sofya": {
            "key": "SOFYA_API_KEY",
            "fn": lambda ctx: collect((request(
                "https://sofya.co/v1/search",
                headers=bearer("SOFYA_API_KEY"),
                body={"query": ctx["query"], "max_results": min(ctx["n"], 10)}) or {}).get("results"), ctx),
        },
        "outcrawl": {
            "key": "OUTCRAWL_API_KEY",
            "fn": lambda ctx: collect((lambda d: d.get("results") or d.get("data") or [])(request(
                "https://api.outcrawl.ai/v1/search",
                headers=bearer("OUTCRAWL_API_KEY"),
                body={"query": ctx["query"], "max_results": min(ctx["n"], 10)})), ctx),
        },
        "ceramic": {
            "key": "CERAMIC_API_KEY",
            "fn": lambda ctx: collect((lambda d: d.get("results") or (d.get("result") or {}).get("results") or [])(request(
                "https://api.ceramic.ai/search",
                headers=bearer("CERAMIC_API_KEY"),
                body={"query": ctx["query"], "max_results": min(ctx["n"], 10)})), ctx),
        },
        "tinyfish": {
            "key": "TINYFISH_API_KEY",
            "fn": lambda ctx: collect((request(
                "https://api.search.tinyfish.ai?" + urllib.parse.urlencode({
                    "query": ctx["query"], "num_results": min(ctx["n"], 10)}),
                method="GET", headers={"x-api-key": env("TINYFISH_API_KEY")}) or {}).get("results"), ctx),
        },
        "tabstack": {
            "key": "TABSTACK_API_KEY",
            "fn": lambda ctx: collect(_walk(request(
                "https://api.tabstack.ai/v1/research",
                headers=bearer("TABSTACK_API_KEY"),
                body={"query": ctx["query"], "max_results": min(ctx["n"], 10)}), [], ctx["n"]), ctx,
                mapper=lambda x: x),
        },
        "parallel": {
            "key": "PARALLEL_API_KEY",
            "fn": lambda ctx: collect((request(
                "https://api.parallel.ai/v1/search",
                headers=bearer("PARALLEL_API_KEY"),
                body={"objective": ctx["query"], "search_queries": [ctx["query"]],
                      "max_results": min(ctx["n"], 10)}) or {}).get("results"), ctx,
                mapper=lambda r: {
                    "title": _trim(r.get("title") or r.get("url"), 200),
                    "url": r.get("url"),
                    "snippet": _trim(" ".join(r["excerpts"]) if isinstance(r.get("excerpts"), list)
                                     else (r.get("excerpt") or r.get("content"))),
                }),
        },
        "deepseek": {
            "key": "DEEPSEEK_API_KEY",
            "fn": lambda ctx: collect((lambda d: d.get("results") or d.get("data") or [])(request(
                "https://api.deepseek.com/v1/tools/search",
                headers=bearer("DEEPSEEK_API_KEY"),
                body={"query": ctx["query"], "count": min(ctx["n"], 10)})), ctx),
        },
        "kimi": {
            "key": "KIMI_API_KEY",
            "fn": lambda ctx: collect(_walk(request(
                "https://api.kimi.com/coding/v1/search",
                headers=bearer("KIMI_API_KEY"),
                body={"text_query": ctx["query"]}), [], ctx["n"]), ctx, mapper=lambda x: x),
        },
        "perplexity": {
            "key": "PERPLEXITY_API_KEY",
            "fn": lambda ctx: collect((lambda d: d.get("results") or d.get("data") or [])(request(
                "https://api.perplexity.ai/search",
                headers=bearer("PERPLEXITY_API_KEY"),
                body={"query": ctx["query"], "max_results": min(ctx["n"], 10)})), ctx),
        },
        # ── LLM-native search ──────────────────────────────────────────
        "openai": {
            "key": "OPENAI_API_KEY",
            "fn": lambda ctx: collect(_walk(request(
                "https://api.openai.com/v1/responses",
                headers=bearer("OPENAI_API_KEY"),
                body={"model": env("OPENAI_SEARCH_MODEL") or "gpt-4o-mini",
                      "tools": [{"type": "web_search_preview"}], "input": ctx["query"]},
                timeout=45), [], ctx["n"]), ctx, mapper=lambda x: x),
        },
        "xai": {
            "key": "XAI_API_KEY",
            "fn": lambda ctx: collect(_walk(request(
                "https://api.x.ai/v1/responses",
                headers=bearer("XAI_API_KEY"),
                body={"model": env("XAI_SEARCH_MODEL") or "grok-4",
                      "tools": [{"type": "web_search"}], "input": ctx["query"]},
                timeout=45), [], ctx["n"]), ctx, mapper=lambda x: x),
        },
        "gemini": {
            "key": "GEMINI_API_KEY",
            "fn": lambda ctx: collect(_walk(request(
                "https://generativelanguage.googleapis.com/v1beta/models/"
                + (env("GEMINI_SEARCH_MODEL") or "gemini-2.0-flash")
                + ":generateContent?key=" + env("GEMINI_API_KEY"),
                body={"contents": [{"parts": [{"text": ctx["query"]}]}],
                      "tools": [{"google_search": {}}]},
                timeout=45), [], ctx["n"]), ctx, mapper=lambda x: x),
        },
        "mistral": {
            "key": "MISTRAL_API_KEY",
            "fn": lambda ctx: collect(_walk(request(
                "https://api.mistral.ai/v1/conversations",
                headers=bearer("MISTRAL_API_KEY"),
                body={"model": env("MISTRAL_SEARCH_MODEL") or "mistral-medium-latest",
                      "inputs": [{"role": "user", "content": ctx["query"]}],
                      "tools": [{"type": "web_search"}]},
                timeout=45), [], ctx["n"]), ctx, mapper=lambda x: x),
        },
        # ── MCP-shaped ─────────────────────────────────────────────────
        "baizhi": {
            "key": "BAIZHI_API_KEY",
            "fn": lambda ctx: collect(_walk(request(
                "https://agent-toolkit.app.baizhi.cloud/mcp",
                headers=bearer("BAIZHI_API_KEY"),
                body={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": "web_search",
                                 "arguments": {"query": ctx["query"], "count": min(ctx["n"], 10)}}}),
                [], ctx["n"]), ctx, mapper=lambda x: x),
        },
        "zai": {
            "key": "ZAI_API_KEY",
            "fn": lambda ctx: collect(_walk(request(
                env("ZAI_BASE_URL") or "https://api.z.ai/api/mcp/web_search_prime/mcp",
                headers=bearer("ZAI_API_KEY"),
                body={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": "web_search_prime",
                                 "arguments": {"search_query": ctx["query"]}}}),
                [], ctx["n"]), ctx, mapper=lambda x: x),
        },
        # ── Self-hosted / account-scoped ───────────────────────────────
        "ninerouter": {
            "key": "NINEROUTER_BASE_URL",
            "fn": lambda ctx: collect((lambda d: d.get("results") or d.get("data") or [])(request(
                (env("NINEROUTER_BASE_URL") or "").rstrip("/") + "/search",
                headers=({"authorization": f"Bearer {env('NINEROUTER_API_KEY')}"}
                         if env("NINEROUTER_API_KEY") else {}),
                body={"query": ctx["query"], "limit": min(ctx["n"], 10)})), ctx),
        },
        "cloudflare": {
            "key": "CLOUDFLARE_API_TOKEN",
            "fn": lambda ctx: collect(_cf(request, ctx, env), ctx),
        },
        "brightdata": {
            "key": "BRIGHTDATA_API_KEY",
            "fn": lambda ctx: collect(organic_of(request(
                "https://api.brightdata.com/request?" + urllib.parse.urlencode({
                    "q": ctx["query"], "zone": env("BRIGHTDATA_ZONE"), "format": "json"}),
                headers=bearer("BRIGHTDATA_API_KEY"))), ctx),
        },
    }

    def _guarded(entry):
        key = entry.get("key")
        inner = entry["fn"]

        def run(ctx):
            if key and not env(key):
                raise RuntimeError(f"{key} not set — this engine needs an API key "
                                   "(see README for the signup link)")
            return inner(ctx)
        return {"key": key, "fn": run}

    return {name: _guarded(entry) for name, entry in engines.items()}


def _cf(request, ctx, env):
    """Cloudflare AI Search needs an account id on top of the token."""
    account = env("CLOUDFLARE_ACCOUNT_ID")
    if not account:
        raise RuntimeError("CLOUDFLARE_ACCOUNT_ID not set")
    data = request(f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/search",
                   headers={"authorization": f"Bearer {env('CLOUDFLARE_API_TOKEN')}"},
                   body={"query": ctx["query"], "max_results": min(ctx["n"], 10)})
    if isinstance(data, dict):
        return data.get("result") or data.get("results") or []
    return []
