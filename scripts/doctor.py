#!/usr/bin/env python3
"""easy-websearch doctor — diagnose engine availability and configuration.

Zero dependencies (stdlib only). Python >= 3.11. Honors HTTP(S)_PROXY env
vars automatically via urllib.

Usage:
  python3 doctor.py [--timeout 8] [--json]

Runs one tiny real search per available engine (concurrently) and reports
per-engine status, latency, and configuration gaps. Exit code: 0 all tested
engines OK, 1 any failure, 2 nothing testable.
"""
import argparse
import concurrent.futures
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from search import ENGINES, available_engines  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser(description="easy-websearch doctor")
    p.add_argument("--timeout", type=int, default=8)
    p.add_argument("--json", action="store_true")
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
    failed = [r for r in rows if r["status"] == "FAIL"]
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or \
        os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or ""

    if args.json:
        print(json.dumps({
            "python": sys.version.split()[0],
            "proxy": proxy or None,
            "cooldown_state_file": _cooldown_path(),
            "engines": rows,
            "summary": {"tested": len(tested), "failed": len(failed),
                        "skipped": len(rows) - len(tested)},
        }, ensure_ascii=False, indent=2))
    else:
        print(f"easy-websearch doctor — python {sys.version.split()[0]}"
              f"{' | proxy: ' + proxy if proxy else ' | no proxy env'}")
        w = max(len(r["engine"]) for r in rows) + 2
        for r in rows:
            mark = "✓" if r["status"] == "OK" else "✗" if r["status"] == "FAIL" else "–"
            print(f"  {mark} {r['engine']:<{w}} {r['status']:<5} {r['ms']:>5}ms  {r['note']}")
        print(f"\n{len(tested)} tested, {len(rows) - len(tested)} skipped, {len(failed)} failed")

    sys.exit(1 if failed else 0 if tested else 2)


if __name__ == "__main__":
    main()
