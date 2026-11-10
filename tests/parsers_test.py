#!/usr/bin/env python3
"""Parser snapshot tests — python twin of tests/parsers.test.mjs.

Keep the assertion matrix in lockstep with the node file: the same trimmed
real markup (tests/snapshots/) must parse identically in both runtimes.
Network-free. Run: python3 tests/parsers_test.py
"""
import os
import sys

# `search` is resolved at runtime via the sys.path.insert below — it lives in
# scripts/ (sibling of tests/), which static import resolution cannot see.
# pyright: reportMissingImports=false, reportMissingModuleSource=false
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

from search import (  # noqa: E402
    _parse_baidu_results,
    _parse_bing_news_rss,
    _parse_bing_results,
    _parse_bing_rss,
    _parse_ddg_html,
    _parse_ddg_lite,
    _parse_so360_desktop,
    _parse_so360_mobile,
)

SNAP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "snapshots")
CTX = {"n": 10}

passed = 0
failed = 0


def snap(name):
    with open(os.path.join(SNAP, name), encoding="utf-8") as f:
        return f.read()


def eq(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
    else:
        failed += 1
        print(f"FAIL: {name}\n  got:  {got!r}\n  want: {want!r}")


def throws(name, fn, msg_part):
    global passed, failed
    try:
        fn()
        failed += 1
        print(f"FAIL: {name} (did not throw)")
    except RuntimeError as e:
        if msg_part in str(e):
            passed += 1
        else:
            failed += 1
            print(f"FAIL: {name} (wrong error: {e})")


# ── ddg html UI ──
r = _parse_ddg_html(CTX, snap("ddg-html.html"))
eq("ddg-html: count", len(r), 2)
eq("ddg-html: uddg decoded", r[0]["url"], "https://developer.mozilla.org/en-US/docs/WebGPU_API")
eq("ddg-html: title", r[0]["title"], "WebGPU API - MDN")
eq("ddg-html: snippet", r[0]["snippet"], "WebGPU API reference docs for the web platform.")
eq("ddg-html: direct href kept", r[1]["url"], "https://direct.example.com/page")

# ── ddg lite UI ──
r = _parse_ddg_lite(CTX, snap("ddg-lite.html"))
eq("ddg-lite: count", len(r), 2)
eq("ddg-lite: uddg decoded (single quotes, href-before-class)", r[0]["url"], "https://learn.microsoft.com/en-us/windows/wsl/install")
eq("ddg-lite: title", r[0]["title"], "Install WSL | Microsoft Learn")
eq("ddg-lite: snippet from <td>", r[0]["snippet"], "Install Windows Subsystem for Linux with the command, wsl --install.")
eq("ddg-lite: direct href kept", r[1]["url"], "https://direct.example.com/page")

# ── bing b_algo ──
r = _parse_bing_results(CTX, snap("bing-balgo.html"))
eq("bing: count", len(r), 2)
eq("bing: /ck/a base64 decoded", r[0]["url"], "https://developer.mozilla.org/en-US/docs/WebGPU_API")
eq("bing: title", r[0]["title"], "WebGPU API - MDN")
eq("bing: snippet", r[0]["snippet"], "WebGPU API reference docs.")
eq("bing: direct href kept", r[1]["url"], "https://direct.example.com/page")

# ── bing RSS ──
r = _parse_bing_rss(CTX, snap("bing-rss.xml"))
eq("bing-rss: count", len(r), 2)
eq("bing-rss: link is direct", r[0]["url"], "https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API")
eq("bing-rss: CDATA title", r[0]["title"], "WebGPU API - MDN")
eq("bing-rss: CDATA desc stripped", r[0]["snippet"], "WebGPU API reference docs.")
eq("bing-rss: entity desc decoded", r[1]["snippet"], "WebGPU tutorial & samples")

# ── baidu desktop ──
r = _parse_baidu_results(CTX, snap("baidu-desktop.html"))
eq("baidu: count", len(r), 2)
eq("baidu: /link wrapper kept (resolved later)", r[0]["url"], "http://www.baidu.com/link?url=abc123def")
eq("baidu: title", r[0]["title"], "Example - Baidu wrapper result")
eq("baidu: non-http href skipped", r[1]["url"], "https://docs.example.com/guide")

# ── so360 desktop ──
r = _parse_so360_desktop(CTX, snap("so360-desktop.html"))
eq("so360-desktop: count", len(r), 2)
eq("so360-desktop: /link?m wrapper kept", r[0]["url"], "https://www.so.com/link?m=abc123")
eq("so360-desktop: title", r[0]["title"], "First 360 Result")
eq("so360-desktop: res-desc snippet", r[0]["snippet"], "First description here.")

# ── so360 mobile ──
r = _parse_so360_mobile(CTX, snap("so360-mobile.html"))
eq("so360-mobile: count", len(r), 2)
eq("so360-mobile: jump?u decoded (card 1)", r[0]["url"], "https://study.example.com/course/1")
eq("so360-mobile: <em> title stripped", r[0]["title"], "react hooks 全套教程")
eq("so360-mobile: g-main summary snippet", r[0]["snippet"], "这个课程主要教大家掌握 react hooks")
eq("so360-mobile: jump?u decoded (card 2)", r[1]["url"], "https://second.example.com/video/42")

# ── bing news RSS ──
r = _parse_bing_news_rss(CTX, snap("bing-news-rss.xml"))
eq("bing-news: count", len(r), 2)
eq("bing-news: url= param extracted + decoded", r[0]["url"], "https://www.msn.cn/zh-cn/技术/nvidia-rtx-5090")
eq("bing-news: CDATA title", r[0]["title"], "Nvidia 否认 RTX 5090 显卡停产")
eq("bing-news: News:Source + pubDate snippet", r[0]["snippet"], "快科技 on MSN · Tue, 09 Nov 2026 08:00:00 GMT")
eq("bing-news: plain item url", r[1]["url"], "https://www.investors.com/news/technology/nvidia-stock/")

# ── empty pages fail with the canonical error ──
throws("ddg-html: empty body", lambda: _parse_ddg_html(CTX, "<div></div>"), "no results parsed")
throws("bing: empty body", lambda: _parse_bing_results(CTX, "<ol></ol>"), "no results parsed")
throws("so360-mobile: empty body", lambda: _parse_so360_mobile(CTX, "<div></div>"), "no results parsed")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
