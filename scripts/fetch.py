#!/usr/bin/env python3
"""fusion-search fetch — extract readable content from a URL as Markdown.

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
import re
import sys
import urllib.error
import urllib.parse
from urllib.request import build_opener

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def http_text(url: str, headers: dict | None = None,
              timeout: float = 15) -> tuple[int, str, str]:
    """GET an http(s) URL, return (status, body, final_url). Follows redirects."""
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
        with opener.open(safe_url, timeout=timeout) as r:
            final = r.geturl()
            return r.status, r.read().decode("utf-8", "ignore"), final
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore"), url


def strip_tags(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]*>", "", s or ""))).strip()


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

    # 2) r.jina.ai reader fallback (free, no key; rate-limited).
    status, body, _ = http_text(f"https://r.jina.ai/{url}",
                                headers={"accept": "text/plain"}, timeout=timeout)
    if status == 200 and body.strip() and len(body.strip()) > 100:
        return {"ok": True, "via": "r.jina.ai", "url": url,
                "chars": len(body), "content": body[:max_chars]}
    return {"ok": False, "url": url,
            "error": (f"direct extraction failed ({direct_error or 'empty/short content'}); "
                      f"reader fallback HTTP {status}")}


def main() -> None:
    p = argparse.ArgumentParser(description="fusion-search fetch: URL → Markdown")
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
