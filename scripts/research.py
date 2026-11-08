#!/usr/bin/env python3
"""easy-websearch research — multi-round evidence collector.

Zero dependencies (stdlib only). Python >= 3.11. Honors HTTP(S)_PROXY env vars
automatically via urllib.

Collects structured evidence (NOT a summary — the agent writes the answer):
  1. Decomposes the question into sub-queries (agent-provided or rule-based)
  2. Runs parallel searches across the engine pool
  3. Fetches top pages per sub-query (title + first chars as evidence)
  4. Compiles a cross-hit annotated evidence pack

Usage:
  python3 scripts/research.py "question" [options]
"""
import concurrent.futures
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from search import available_engines, http_text, set_force_direct  # noqa: E402

# ────────────────────────────────────────────── CLI ──
import argparse

p = argparse.ArgumentParser(description="easy-websearch research: multi-round evidence collector")
p.add_argument("question", nargs="+")
p.add_argument("--queries", default="", help="explicit sub-queries (comma-separated)")
p.add_argument("--depth", type=int, default=2, help="pages to fetch per sub-query")
p.add_argument("--lang", default="", help="language boost")
p.add_argument("--max-searches", type=int, default=8)
p.add_argument("--max-fetches", type=int, default=12)
p.add_argument("--timeout", type=int, default=8)
p.add_argument("--json", action="store_true")
p.add_argument("--direct", action="store_true", help="bypass proxy for all requests")
args = p.parse_args()

question = " ".join(args.question).strip().strip("\"'")
if not question:
    p.print_help()
    sys.exit(2)

if args.direct or os.environ.get("EASY_WEB_SEARCH_DIRECT") == "1":
    set_force_direct(True)

# ─────────────────────────────── sub-query generation ──
def _default_sub_queries(q):
    subs = [q]
    cjk = bool(re.search(r"[\u4e00-\u9fa5]", q))
    ascii_runs = re.findall(r"[A-Za-z][A-Za-z0-9+#./ _-]{2,}", q)
    if ascii_runs and not re.match(r"^[a-zA-Z0-9\s]+$", q.strip()):
        en = " ".join(s.strip() for s in ascii_runs if len(s.strip()) >= 3)
        if en:
            subs.append(en)
    if cjk:
        if not re.search(r"什么|如何|怎么|为什么", q):
            subs.append(q + " 是什么")
        if not re.search(r"教程|入门|使用", q):
            subs.append(q + " 教程")
    else:
        if not re.search(r"tutorial|how to|guide", q.lower()):
            subs.append(q + " tutorial")
        if not re.search(r"best|comparison|review", q.lower()):
            subs.append(q + " best practices")
    return subs[:6]

sub_queries = (
    [s.strip() for s in args.queries.split(",") if s.strip()][:6]
    if args.queries
    else _default_sub_queries(question)
)

budget = {"searches": 0, "fetches": 0}
evidence = []
url_hits = {}

# ─────────────────────────────────────────── searching ──
def run_search(sub_query):
    if budget["searches"] >= args.max_searches:
        return None
    budget["searches"] += 1
    engine_ctx = {
        "query": sub_query, "n": 5, "days": 0, "lang": args.lang,
        "timeout": args.timeout, "engines": "", "json": True,
        "site": [], "exclude_site": [], "env": {},
    }
    usable = available_engines("", {})  # already excludes backup/auto/keyed-no-key
    if not usable:
        return {"sub_query": sub_query, "results": [], "engines_used": []}

    statuses = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(usable)) as ex:
        future_to_name = {}
        for name, fn in usable:
            fut = ex.submit(fn, engine_ctx)
            future_to_name[fut] = name
        for fut in concurrent.futures.as_completed(future_to_name):
            name = future_to_name[fut]
            try:
                results = fut.result()
                statuses.append({"name": name, "ok": True, "results": results})
            except Exception as e:
                statuses.append({"name": name, "ok": False, "results": [], "error": str(e)})

    # RRF fusion
    by_url = {}
    for s in statuses:
        if not s["ok"]:
            continue
        engine_name = s["name"]
        for idx, r in enumerate(s["results"]):
            key = _normalize_url(r["url"])
            if key not in by_url:
                by_url[key] = {**r, "score": 0.0, "engines": []}
            item = by_url[key]
            item["score"] += 1 / (60 + idx + 1)
            if engine_name not in item["engines"]:
                item["engines"].append(engine_name)
            if len(item.get("snippet", "")) < len(r.get("snippet", "")):
                item["snippet"] = r.get("snippet", "")
    fused = sorted(by_url.values(), key=lambda x: -x["score"])[:8]
    for r in fused:
        key = _normalize_url(r["url"])
        if key not in url_hits:
            url_hits[key] = {"engines": set(), "count": 0}
        url_hits[key]["count"] += 1
        url_hits[key]["engines"].update(r.get("engines", []))
    return {"sub_query": sub_query, "results": fused, "engines_used": [s["name"] for s in statuses]}


def _normalize_url(u: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(u)
        query = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query)
                 if not re.match(r"^(utm_|ref$|fbclid)", k, re.I)]
        s = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc.lower(), parsed.path,
                                     urllib.parse.urlencode(query), ""))
        return s.rstrip("/")
    except ValueError:
        return u


# ─────────────────────────────────────────── fetching ──
def fetch_page(url):
    if budget["fetches"] >= args.max_fetches:
        return None
    budget["fetches"] += 1
    try:
        status, body = http_text(url, timeout=max(args.timeout * 1.5, 12))
        if status != 200 or len(body) < 200:
            return {"url": url, "ok": False, "reason": f"HTTP {status}"}
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]*>", "", body)).strip()
        return {"url": url, "ok": True, "chars": len(text), "excerpt": text[:2000]}
    except (RuntimeError, OSError) as e:
        return {"url": url, "ok": False, "reason": str(e)[:80]}


# ─────────────────────────────────────────── main loop ──

search_futures = []
with concurrent.futures.ThreadPoolExecutor(max_workers=len(sub_queries)) as ex:
    search_futures = list(ex.map(run_search, sub_queries))

search_results = [s for s in search_futures if s]

fetch_targets = []
seen = set()
for sr in search_results:
    for r in sr.get("results", [])[: args.depth]:
        key = _normalize_url(r["url"])
        if key not in seen:
            seen.add(key)
            fetch_targets.append(r["url"])

fetch_results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(fetch_targets), 6)) as ex:
    fetch_results = list(ex.map(fetch_page, fetch_targets[: args.max_fetches]))

fetch_by_url = {f["url"]: f for f in fetch_results if f}
for sr in search_results:
    for r in sr.get("results", []):
        f = fetch_by_url.get(r["url"])
        if f and f.get("ok"):
            r["fetched"] = True
            r["content_excerpt"] = f["excerpt"]
    evidence.append(sr)

cross_hits = sorted(
    [{"url": u, "engines": sorted(h["engines"]), "count": h["count"]}
     for u, h in url_hits.items() if h["count"] >= 2],
    key=lambda x: -x["count"],
)[:15]

coverage = {}
for sr in evidence:
    for e in sr.get("engines_used", []):
        coverage[e] = coverage.get(e, 0) + 1

evidence_pack = {
    "question": question,
    "sub_queries": sub_queries,
    "evidence": evidence,
    "cross_hits": cross_hits,
    "budget_used": budget,
    "coverage": coverage,
}

if args.json:
    print(json.dumps(evidence_pack, ensure_ascii=False, indent=2))
else:
    print(f"═══ research: {question} ═══")
    print(f"子查询 {len(sub_queries)} 个 · 搜索 {budget['searches']} 次 · 抓取 {budget['fetches']} 页 · "
          f"交叉命中 {len(cross_hits)} 个 URL\n")
    for sr in evidence:
        print(f"── {sr['sub_query']} ──")
        for r in sr.get("results", [])[:5]:
            fetched = " 📄已抓取" if r.get("fetched") else ""
            print(f"  {r['title']}")
            print(f"    {r['url']}  [{', '.join(r.get('engines', []))}]{fetched}")
            if r.get("snippet"):
                print(f"    {r['snippet'][:120]}")
    if cross_hits:
        print("\n── 交叉命中（多引擎共同认可）──")
        for c in cross_hits[:5]:
            print(f"  {c['count']}× {c['url']}")
    print(f"\n预算: 搜索 {budget['searches']}/{args.max_searches} · 抓取 {budget['fetches']}/{args.max_fetches}")
    print("下一步: 将本证据包交给 agent 总结（结论需带 URL，冲突来源并列呈现）")
