#!/usr/bin/env python3
"""easy-websearch fetch — extract readable content from a URL as Markdown.

Zero dependencies (stdlib only). Python >= 3.11. Honors HTTP(S)_PROXY env
vars automatically via urllib.

Usage:
  python3 fetch.py <url> [--json] [--timeout 15] [--max-chars 20000]

Strategy (reliability-first):
  1. Direct fetch + built-in HTML-to-Markdown extraction.
  2. If blocked (403/429/5xx) or extraction is empty → r.jina.ai reader
     fallback (free, no key; may be rate-limited).
Always exits 0 with --json and reports {"ok": false} instead of crashing.
"""
import argparse
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from urllib.request import build_opener

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def http_text(url: str, headers: dict | None = None,
              timeout: float = 15, method: str = "GET",
              data: bytes | None = None) -> tuple[int, str, str]:
    """Fetch an http(s) URL, return (status, body, final_url). Follows redirects."""
    # Explicit scheme allowlist: only plain http(s) URLs may reach the opener.
    if not url.lower().startswith(("http://", "https://")):
        raise RuntimeError(f"disallowed URL scheme (want http/https): {url[:80]}")
    # Only the validated http(s) URL reaches the opener below.
    safe_url: str = urllib.parse.urlunsplit(urllib.parse.urlsplit(url))
    opener = build_opener()
    opener.addheaders = list({
        "User-agent": UA,
        "Accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        **(headers or {}),
    }.items())
    try:
        # safe_url passed the explicit http/https allowlist above.
        with opener.open(urllib.request.Request(safe_url, data=data, method=method),  # noqa: S310
                         timeout=timeout) as r:
            final = r.geturl()
            return r.status, r.read().decode("utf-8", "ignore"), final
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore"), url


def strip_tags(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]*>", "", s or ""))).strip()


def _parse_json(body: str) -> dict:
    """json.loads with a structured error (callers isolate fallback steps)."""
    try:
        return json.loads(body)
    except ValueError as e:
        raise RuntimeError(f"invalid JSON response: {e}") from e


_ENTITIES = {"mdash": "—", "ldquo": "“", "rdquo": "”", "lsquo": "‘",
             "rsquo": "’", "hellip": "…", "copy": "©"}


def inline(s: str) -> str:
    s = re.sub(r"<(script|style|noscript|svg)[^>]*>[\s\S]*?</\1>", "", s or "", flags=re.I)
    s = re.sub(r"<[^>]*>", "", s)
    s = html.unescape(s)
    return re.sub(r"[ \t]+", " ", s).strip()


def html_to_markdown(body: str) -> str:
    h = re.sub(r"<script[\s\S]*?</script>", "", body, flags=re.I)
    h = re.sub(r"<style[\s\S]*?</style>", "", h, flags=re.I)
    h = re.sub(r"<noscript[\s\S]*?</noscript>", "", h, flags=re.I)
    h = re.sub(r"<(nav|header|footer|aside|form)[^>]*>[\s\S]*?</\1>", "", h, flags=re.I)
    # Footer/boilerplate blocks identified by id/class (ICP 备案, copyright…)
    h = re.sub(r"<div[^>]*(?:id|class)=[\"'][^\"']*(?:footer|copyright|icp|beian)[^\"']*[\"'][^>]*>[\s\S]*?</div>", "", h, flags=re.I)
    h = re.sub(r"<!--[\s\S]*?-->", "", h)

    m = re.search(r"<title[^>]*>([\s\S]*?)</title>", h, re.I)
    title = inline(m.group(1)) if m else ""
    m = (re.search(r"<meta[^>]+name=[\"']description[\"'][^>]+content=[\"']([^\"']+)[\"']", h, re.I) or
         re.search(r"<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+name=[\"']description[\"']", h, re.I))
    desc = inline(m.group(1)) if m else ""

    h = re.sub(r"<h([1-6])[^>]*>([\s\S]*?)</h\1>",
               lambda g: f"\n\n{'#' * int(g.group(1))} {inline(g.group(2))}\n\n", h, flags=re.I)
    h = re.sub(r"<li[^>]*>([\s\S]*?)</li>", lambda g: f"\n- {inline(g.group(1))}", h, flags=re.I)
    h = re.sub(r"</(p|div|section|article|tr|blockquote|pre)>", "\n\n", h, flags=re.I)
    h = re.sub(r"<br\s*/?>", "\n", h, flags=re.I)
    h = re.sub(r"<hr\s*/?>", "\n\n---\n\n", h, flags=re.I)
    h = re.sub(r"<[^>]*>", " ", h)

    text = html.unescape(h)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()

    meta = []
    if title:
        meta.append(f"# {title}")
    if desc:
        meta.append(f"> {desc}")
    if meta:
        text = "\n\n".join(meta) + "\n\n" + text
    return text


def extract(url: str, timeout: float, max_chars: int) -> dict:
    # 1) Direct fetch + local extraction.
    direct_error = ""
    try:
        status, body, final = http_text(url, timeout=timeout)
        if status == 200 and re.search(r"<\w+[\s\S]*>", body):
            md = html_to_markdown(body)
            if len(md) > 200:
                return {"ok": True, "via": "direct", "url": final,
                        "chars": len(md), "content": md[:max_chars]}
    except (RuntimeError, urllib.error.URLError, OSError) as e:
        direct_error = f"{type(e).__name__}: {e}"  # fall through to reader fallback

    # 1b) Keyless MCP readers — cleaner than the jina reader, no key required.
    for reader in (lambda: exa_fetch(url, timeout, max_chars),
                   lambda: parallel_fetch(url, timeout)):
        try:
            got = reader()
        except (RuntimeError, OSError):
            got = None
        if got:
            return {"ok": True, "via": got["via"], "url": url,
                    "chars": len(got["content"]), "content": got["content"][:max_chars]}

    # 2) Firecrawl scrape (when FIRECRAWL_API_KEY is set) — higher quality
    #    extraction than the reader fallback, uses the key's quota.
    firecrawl_error = ""
    firecrawl_key = os.environ.get("FIRECRAWL_API_KEY")
    if firecrawl_key:
        try:
            status, body, _ = http_text(
                "https://api.firecrawl.dev/v1/scrape",
                headers={"content-type": "application/json",
                         "authorization": f"Bearer {firecrawl_key}"},
                timeout=timeout)
            res = _parse_json(body)
            md = ((res.get("data") or {}).get("markdown") or "") if isinstance(res, dict) else ""
            if status == 200 and res.get("success") is not False and len(md) > 100:
                return {"ok": True, "via": "firecrawl", "url": url,
                        "chars": len(md), "content": md[:max_chars]}
        except (RuntimeError, urllib.error.URLError, OSError, ValueError) as e:
            firecrawl_error = f"{type(e).__name__}: {e}"  # unavailable → reader fallback

    # 3) r.jina.ai reader fallback (free, no key; rate-limited).
    status, body, _ = http_text(f"https://r.jina.ai/{url}",
                                headers={"accept": "text/plain"}, timeout=timeout)
    if status == 200 and body.strip() and len(body.strip()) > 100:
        return {"ok": True, "via": "r.jina.ai", "url": url,
                "chars": len(body), "content": body[:max_chars]}
    return {"ok": False, "url": url,
            "error": (f"direct + firecrawl extraction failed "
                      f"({direct_error or 'empty/short content'}; {firecrawl_error or 'not configured/empty'}); "
                      f"reader fallback HTTP {status} — the target site may have rejected the reader too "
                      f"(note: fetch targets HTML pages — read JSON/text endpoints directly)")}


# ---------------------------------------------------- keyless MCP readers ----
# exa and parallel both expose a free fetch tool over the same JSON-RPC shape
# their search uses. They extract cleaner text than r.jina.ai and need no key.
EXA_MCP_FETCH = "https://mcp.exa.ai/mcp?tools=web_fetch_exa"
PARALLEL_MCP = "https://search.parallel.ai/mcp"


def _mcp_fetch_text(url: str, tool: str, arguments: dict, timeout: float) -> str | None:
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
               "params": {"name": tool, "arguments": arguments}}
    try:
        status, body, _ = http_text(url, method="POST", data=json.dumps(payload).encode(),
                                    headers={"content-type": "application/json",
                                             "accept": "application/json, text/event-stream",
                                             "user-agent": "easy-websearch"},
                                    timeout=timeout)
    except (RuntimeError, OSError):
        return None
    if status != 200:
        return None
    parsed = None
    if "data:" in body:
        for line in body.split("\n"):
            if not line.startswith("data:"):
                continue
            try:
                frame = json.loads(line[5:].strip())
            except ValueError:
                continue  # keepalive/partial SSE frame — the next one carries the result
            if isinstance(frame, dict) and frame.get("result"):
                parsed = frame
    if parsed is None:
        try:
            parsed = json.loads(body)
        except ValueError:
            return None
    content = (parsed.get("result") or {}).get("content") or []
    return content[0].get("text") if content and isinstance(content[0], dict) else None


def exa_fetch(url: str, timeout: float, max_chars: int) -> dict | None:
    text = _mcp_fetch_text(EXA_MCP_FETCH, "web_fetch_exa",
                           {"urls": [url], "maxCharacters": max_chars}, timeout)
    if not text or len(text) < 100:
        return None
    return {"via": "exa-mcp", "content": text}


def parallel_fetch(url: str, timeout: float) -> dict | None:
    text = _mcp_fetch_text(PARALLEL_MCP, "web_fetch",
                           {"urls": [url], "objective": "extract the readable content of this page"},
                           timeout)
    if not text:
        return None
    try:
        inner = json.loads(text)
    except ValueError:
        return None
    hit = (inner.get("results") or [{}])[0]
    content = "\n\n".join(hit.get("excerpts") or []).strip()
    if len(content) < 100:
        return None
    title = hit.get("title")
    return {"via": "parallel-mcp", "content": (f"# {title}\n\n" if title else "") + content}


def main() -> None:
    p = argparse.ArgumentParser(description="easy-websearch fetch: URL → Markdown")
    p.add_argument("url")
    p.add_argument("--json", action="store_true")
    p.add_argument("--timeout", type=int, default=15)
    p.add_argument("--max-chars", type=int, default=20000)
    args = p.parse_args()

    try:
        out = extract(args.url, args.timeout, args.max_chars)
    except (RuntimeError, urllib.error.URLError, OSError) as e:
        out = {"ok": False, "url": args.url, "error": str(e)}

    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif out.get("ok"):
        print(out["content"])
        print(f"\n--- [via {out['via']}, {out['chars']} chars] ---", file=sys.stderr)
    else:
        print(f"FAILED: {out.get('error')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
