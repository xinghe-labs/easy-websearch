#!/usr/bin/env python3
"""Unit tests for pure functions in search.py — python twin of tests/unit.mjs.

Keep the assertion matrix in lockstep with the node file: the same 23 checks
must pass in both runtimes (see tests/parity.sh). Network-free.
Run: python3 tests/unit_test.py
"""
import os
import sys

# `search` is resolved at runtime via the sys.path.insert below — it lives in
# scripts/ (sibling of tests/), which static import resolution cannot see.
# pyright: reportMissingImports=false, reportMissingModuleSource=false
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

from search import (  # noqa: E402
    _extract_intl_query,
    _looks_like_junk,
    _searxng_base_and_auth,
    normalize_url,
    route_auto,
)

passed = 0
failed = 0


def eq(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
    else:
        failed += 1
        print(f"FAIL: {name}\n  got:  {got!r}\n  want: {want!r}")


def ok(name, cond):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"FAIL: {name}")


# ── route_auto ──
eq("routeAuto: github signal", route_auto("github 教程")["engines"], ["github"])
eq("routeAuto: 学术五件套", route_auto("论文 写作")["engines"], ["arxiv", "openalex", "crossref", "pubmed", "semanticscholar"])
eq("routeAuto: 什么是→wikipedia", route_auto("什么是 webgpu")["engines"], ["wikipedia"])
eq("routeAuto: 掘金+csdn", route_auto("掘金 教程")["engines"], ["juejin", "csdn"])
eq("routeAuto: huggingface", route_auto("数据集 下载")["engines"], ["huggingface"])
eq("routeAuto: 新闻→bingnews", route_auto("AI 最新新闻")["engines"], ["bingnews"])
eq("routeAuto: gitee 无 token 不路由", route_auto("开源仓库 推荐", {})["engines"], ["github"])
eq("routeAuto: 无匹配→空", route_auto("今天天气")["engines"], [])
eq("routeAuto: 空查询→空", route_auto("")["engines"], [])

# ── _looks_like_junk ──
junk = [
    {"title": "Google", "url": "https://www.google.com/"},
    {"title": "Google", "url": "https://www.google.com.hk/"},
    {"title": "Google", "url": "https://google.cn/"},
]
good = [
    {"title": "WebGPU API - MDN", "url": "https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API", "snippet": "WebGPU API reference"},
    {"title": "Learn WebGPU", "url": "https://webgpufundamentals.org/", "snippet": "WebGPU tutorial"},
]
ok("junk: 单域 SERP", _looks_like_junk(junk, "webgpu") is True)
ok("junk: 零词重叠", _looks_like_junk([
    {"title": "灌注", "url": "https://baike.baidu.com/item/1"},
    {"title": "首页", "url": "https://example.com/"},
], "webgpu") is True)
ok("junk: 正常结果不误伤", _looks_like_junk(good, "webgpu") is False)
ok("junk: 少于2条不判", _looks_like_junk(good[:1], "webgpu") is False)

# ── normalize_url ──
eq("normalize: 去 utm", normalize_url("https://example.com/page?utm_source=x&id=1"), "https://example.com/page?id=1")
eq("normalize: 去 fbclid", normalize_url("https://example.com/?fbclid=abc"), "https://example.com")
eq("normalize: 去 hash", normalize_url("https://example.com/a#section"), "https://example.com/a")
eq("normalize: 去尾斜杠", normalize_url("https://example.com/"), "https://example.com")
eq("normalize: 保留合法参数", normalize_url("https://example.com/search?q=test&page=2"), "https://example.com/search?q=test&page=2")

# ── _extract_intl_query ──
eq("intl: 英文优先", _extract_intl_query("webgpu 是什么"), "webgpu")
eq("intl: 长词优先", _extract_intl_query("use webgpu for game development"), "use webgpu for game development")
eq("intl: 纯中文回退原文", _extract_intl_query("机器学习 入门"), "机器学习 入门")

# ── _searxng_base_and_auth ──
base, authorization = _searxng_base_and_auth("https://user:pass@searx.example.com")
eq("searxng auth: base", base, "https://searx.example.com")
eq("searxng auth: header", authorization, "Basic dXNlcjpwYXNz")
base2, authorization2 = _searxng_base_and_auth("http://1.2.3.4:8080")
eq("searxng noauth: base", base2, "http://1.2.3.4:8080")
eq("searxng noauth: header空", authorization2, "")

# ── summary ──
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
