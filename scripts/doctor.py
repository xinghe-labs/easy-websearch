#!/usr/bin/env python3
"""easy-websearch doctor — diagnose engine availability and configuration.

Zero dependencies (stdlib only). Python >= 3.11. Honors HTTP(S)_PROXY env
vars automatically via urllib.

Usage:
  python3 doctor.py [--timeout 8] [--json] [--strict]

Runs one tiny real search per available engine (concurrently) and reports
per-engine status, latency, and configuration gaps.

Status: OK | SKIP (key not set) | WARN (transient: anti-bot, rate limit,
timeout, unparsable response) | FAIL (real problem, e.g. bad config).
By default transient failures are reported as WARN and do NOT change the
exit code — public engines block datacenter exits all the time and that is
not a broken install. `--strict` treats every failure as FAIL.

Exit code: 0 all tested engines OK or WARN, 1 any FAIL, 2 nothing testable.
"""
import argparse
import concurrent.futures
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from search import ENGINES, available_engines  # noqa: E402

# Failures that say "the network/engine is having a bad day", not "your
# install is broken". Demoted to WARN unless --strict is passed.
TRANSIENT = re.compile(
    r"anti-bot|security verification|captcha|challenge|anomaly|blocked"
    r"|rate limit|too many requests|\b429\b|\btimeout\b|no results parsed"
    r"|HTTP 202|HTTP 403|HTTP 5\d\d",
    re.IGNORECASE,
)


def main() -> None:
    p = argparse.ArgumentParser(description="easy-websearch doctor")
    p.add_argument("--timeout", type=int, default=8)
    p.add_argument("--json", action="store_true")
    p.add_argument("--strict", action="store_true",
                   help="treat transient failures (anti-bot / rate limit / timeout) as failures")
    p.add_argument("--clear-cooldown", action="store_true",
                   help="reset the failure-cooldown state and exit")
    args = p.parse_args()

    if args.clear_cooldown:
        from search import _cooldown_path
        path = _cooldown_path()
        try:
            os.remove(path)
            print(f"cooldown state cleared: {path}")
        except FileNotFoundError:
            print(f"no cooldown state to clear ({path})")
        except OSError as e:
            print(f"failed to clear cooldown state ({path}): {e}", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)

    env = {k: os.environ[k] for k in
           ("BRAVE_API_KEY", "TAVILY_API_KEY", "SERPER_API_KEY", "EXA_API_KEY",
            "FIRECRAWL_API_KEY", "BOCHA_API_KEY", "METASO_API_KEY", "LINKUP_API_KEY",
            "OLLAMA_API_KEY", "ANYSEARCH_API_KEY", "KEENABLE_API_KEY",
            "SEARXNG_BASE_URL", "EASY_WEB_SEARCH_ENGINES")
           if os.environ.get(k)}
    default_set = {name for name, _ in available_engines("", env)}
    opt_in = [s.strip() for s in os.environ.get("EASY_WEB_SEARCH_ENGINES", "").split(",")
              if s.strip() in ENGINES]
    ctx = {"query": "hello world", "n": 1, "days": 0, "lang": "",
           "timeout": args.timeout, "env": env}

    rows: list[dict] = []

    from search import _cooldown_path
    try:
        with open(_cooldown_path(), encoding="utf-8") as f:
            cooldown_state = json.load(f) or {}
    except (OSError, ValueError):
        cooldown_state = {}
    now_ms = int(time.time() * 1000)

    def cooldown_note(name: str) -> str:
        cd = cooldown_state.get(name) or {}
        return f" [cooldown: {cd.get('reason', 'recent failure')}]" if cd.get("until", 0) > now_ms else ""

    KEY_URLS = {
        "BRAVE_API_KEY": "brave.com/search/api",
        "TAVILY_API_KEY": "app.tavily.com",
        "SERPER_API_KEY": "serper.dev",
        "EXA_API_KEY": "dashboard.exa.ai",
        "FIRECRAWL_API_KEY": "firecrawl.dev",
        "BOCHA_API_KEY": "open.bochaai.com",
        "METASO_API_KEY": "metaso.cn/search-api/api-keys",
        "LINKUP_API_KEY": "linkup.so",
        "OLLAMA_API_KEY": "ollama.com → Account → API keys",
        "SEARXNG_BASE_URL": "self-hosted — see README SearXNG section",
        "ANYSEARCH_API_KEY": "anysearch.com",
        "KEENABLE_API_KEY": "keenable.ai",
        "GOOGLE_API_KEY": "console.cloud.google.com → APIs → Custom Search API",
        "GOOGLE_CX": "programmablesearchengine.google.com → search engine id",
        "GITEE_TOKEN": "gitee.com/profile/personal_access_tokens",
        "S2_API_KEY": "semanticscholar.org/product/api (free, lifts 429s)",
        "SERPAPI_API_KEY": "serpapi.com/manage-api-key",
        "SERPBASE_API_KEY": "serpbase.dev",
        "SEARCHAPI_API_KEY": "www.searchapi.io",
        "SERPLY_API_KEY": "serply.io",
        "XCRAWL_API_KEY": "xcrawl.com",
        "KAGI_API_KEY": "kagi.com/settings?p=api",
        "SERPDIVE_API_KEY": "serpdive.com/dashboard/keys",
        "VALYU_API_KEY": "platform.valyu.ai",
        "YOU_API_KEY": "you.com/platform/api-keys",
        "JINA_API_KEY": "jina.ai/api-dashboard",
        "SEARCH1API_API_KEY": "dashboard.search1api.com",
        "SEARCHINFINITY_API_KEY": "console.byteplus.com/search-infinity/api-key",
        "QUERIT_API_KEY": "querit.ai/en/dashboard/api-keys",
        "SOFYA_API_KEY": "sofya.co/dashboard",
        "OUTCRAWL_API_KEY": "outcrawl.ai",
        "CERAMIC_API_KEY": "platform.ceramic.ai/keys",
        "TINYFISH_API_KEY": "agent.tinyfish.ai/api-keys",
        "TABSTACK_API_KEY": "console.tabstack.ai",
        "PARALLEL_API_KEY": "platform.parallel.ai",
        "DEEPSEEK_API_KEY": "platform.deepseek.com/api_keys",
        "KIMI_API_KEY": "platform.moonshot.cn",
        "PERPLEXITY_API_KEY": "perplexity.ai/settings/api",
        "OPENAI_API_KEY": "platform.openai.com/api-keys",
        "XAI_API_KEY": "console.x.ai",
        "GEMINI_API_KEY": "aistudio.google.com/apikey",
        "MISTRAL_API_KEY": "console.mistral.ai/api-keys",
        "BAIZHI_API_KEY": "agent-toolkit.app.baizhi.cloud",
        "ZAI_API_KEY": "open.bigmodel.cn",
        "NINEROUTER_BASE_URL": "self-hosted — set the router base URL (…/v1)",
        "CLOUDFLARE_API_TOKEN": "dash.cloudflare.com → API Tokens (+ CLOUDFLARE_ACCOUNT_ID)",
        "BRIGHTDATA_API_KEY": "brightdata.com (+ BRIGHTDATA_ZONE)",
    }

    def probe(name: str) -> dict:
        fn, key, flags = ENGINES[name]
        optional_key = "optional_key" in flags
        backup = "backup" in flags
        if key and not env.get(key) and not optional_key:
            where = f" — get it: {KEY_URLS[key]}" if key in KEY_URLS else ""
            return {"engine": name, "status": "SKIP", "ms": 0, "note": f"{key} not set{where}"}
        t0 = time.time()
        try:
            results = fn(ctx)
            note = f"{len(results)} result{'s' if len(results) != 1 else ''}"
            if backup:
                note += " [backup]"
            if name not in default_set and name not in opt_in:
                note += " [not in default set]"
            note += cooldown_note(name)
            return {"engine": name, "status": "OK", "ms": int((time.time() - t0) * 1000), "note": note}
        except Exception as e:
            return {"engine": name, "status": "FAIL", "ms": int((time.time() - t0) * 1000),
                    "note": str(e) + cooldown_note(name)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(ENGINES)) as ex:
        futures = [ex.submit(probe, name) for name in ENGINES]
        for fut in concurrent.futures.as_completed(futures):
            rows.append(fut.result())
    rows.sort(key=lambda r: list(ENGINES).index(r["engine"]))

    tested = [r for r in rows if r["status"] != "SKIP"]
    if not args.strict:
        for r in rows:
            if r["status"] == "FAIL" and TRANSIENT.search(r["note"]):
                r["status"] = "WARN"
    failed = [r for r in rows if r["status"] == "FAIL"]
    warned = [r for r in rows if r["status"] == "WARN"]
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or \
        os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or ""
    scrape_failed = [r for r in failed if r["engine"] in ("ddg", "bing", "baidu", "sogouweb", "so360", "sogouweixin")]
    proxy_hint = []
    if proxy and len(scrape_failed) >= 2:
        proxy_hint = [
            f"hint: {len(scrape_failed)} scrape engines failed while a proxy is active —",
            "      anti-bot layers block datacenter proxy exits. Bypass with:",
            "      no_proxy=<domain>  |  EASY_WEB_SEARCH_DIRECT=1  |  doctor --direct",
        ]

    if args.json:
        print(json.dumps({
            "python": sys.version.split()[0],
            "proxy": proxy or None,
            "cooldown_state_file": _cooldown_path(),
            "hints": proxy_hint,
            "engines": rows,
            "strict": args.strict,
            "summary": {"tested": len(tested), "failed": len(failed),
                        "warned": len(warned),
                        "skipped": len(rows) - len(tested)},
        }, ensure_ascii=False, indent=2))
    else:
        print(f"easy-websearch doctor — python {sys.version.split()[0]}"
              f"{' | proxy: ' + proxy if proxy else ' | no proxy env'}"
              f"{' | strict' if args.strict else ''}")
        w = max(len(r["engine"]) for r in rows) + 2
        marks = {"OK": "✓", "FAIL": "✗", "WARN": "⚠", "SKIP": "–"}
        for r in rows:
            mark = marks.get(r["status"], "–")
            print(f"  {mark} {r['engine']:<{w}} {r['status']:<5} {r['ms']:>5}ms  {r['note']}")
        print(f"\n{len(tested)} tested, {len(rows) - len(tested)} skipped, "
              f"{len(failed)} failed, {len(warned)} warned")
        if warned and not args.strict:
            print("⚠ = transient (anti-bot / rate limit / timeout) — expected on public engines, not an install problem")
            print("  run with --strict to treat these as failures")
        for line in proxy_hint:
            print(line)

    sys.exit(1 if failed else 0 if tested else 2)


if __name__ == "__main__":
    main()
