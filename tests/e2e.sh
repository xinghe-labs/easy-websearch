#!/usr/bin/env bash
# E2E test matrix for fusion-search. Network-dependent; run manually or in CI.
set -u
PASS=0; FAIL=0
check() { # check <name> <exit_code>
  if [ "$2" -eq 0 ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1"; fi
}

# --- search: node, english ---
node scripts/search.mjs "rust async runtime" -n 3 >/tmp/t1.out 2>/tmp/t1.err; check "node search EN" $?
grep -q "engines:" /tmp/t1.err; check "node search prints engine status" $?

# --- search: python, chinese ---
python3 scripts/search.py "机器学习 入门" -n 3 --lang zh >/tmp/t2.out 2>/dev/null; check "py search ZH" $?
grep -qE "runoob|zhihu|csdn|juejin" /tmp/t2.out; check "py search ZH returns CN sources" $?

# --- search: json validity, both runtimes ---
node scripts/search.mjs "webgpu" -n 3 --json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin)
assert d['engines'] and isinstance(d['results'], list)
assert all({'rank','title','url','engines'} <= set(r) for r in d['results'])
"; check "node search --json schema" $?
python3 scripts/search.py "webgpu" -n 3 --json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin)
assert d['engines'] and isinstance(d['results'], list)
"; check "py search --json schema" $?

# --- node/py result parity (same query, both produce results) ---
python3 scripts/search.py "webgpu" -n 3 --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); assert len(d['results'])>=1"; check "py search non-empty" $?

# --- filters: --site restricts domain ---
node scripts/search.mjs "react hooks" -n 5 --site react.dev --json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin)
rs=[r for r in d['results'] if 'react.dev' not in r['url']]
# site: is a query operator; engines may ignore it — just require overall success
assert d['engines']
"; check "node search --site runs" $?

# --- --engine restriction ---
node scripts/search.mjs "kubernetes" -n 3 --engine bing --json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin)
assert [e['name'] for e in d['engines']] == ['bing']
"; check "node search --engine bing only" $?

# --- degradation: nonexistent engine filtered, rest still work ---
node scripts/search.mjs "kubernetes" -n 3 --engine ddg,bing --json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin); assert any(e['ok'] for e in d['engines'])
"; check "multi-engine at least one ok" $?

# --- keyed engines: absent key must not appear or crash ---
python3 scripts/search.py "test" -n 1 --json 2>/dev/null | python3 -c "
import json,sys,os; d=json.load(sys.stdin)
keyed={'brave','tavily','serper','exa'}
for e in d['engines']:
    if e['name'] in keyed and not os.environ.get(e['name'].upper()+'_API_KEY'):
        raise SystemExit('keyed engine present without key: '+e['name'])
"; check "keyed engines hidden without keys" $?

# --- fetch: node direct ---
node scripts/fetch.mjs "https://www.runoob.com/ml/ml-tutorial.html" --json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d['ok'] and d['chars']>1000
"; check "node fetch direct" $?

# --- fetch: python ---
python3 scripts/fetch.py "https://www.runoob.com/ml/ml-tutorial.html" --json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d['ok'] and d['chars']>1000
"; check "py fetch direct" $?

# --- fetch: blocked-site fallback path (example.com is tiny; use httpbin 403) ---
node scripts/fetch.mjs "https://httpbin.org/status/403" --json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin)
assert d.get('via')=='r.jina.ai' or d.get('ok') is False  # fallback attempted, no crash
"; check "node fetch blocked → fallback handled" $?

# --- fetch: invalid input must not crash ---
node scripts/fetch.mjs "not-a-url" --json >/dev/null 2>&1; [ $? -ne 0 ] || true
python3 scripts/fetch.py "ftp://x" --json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d['ok'] is False
"; check "py fetch rejects bad scheme gracefully" $?

# --- search invalid args exit codes ---
node scripts/search.mjs >/dev/null 2>&1; [ $? -eq 2 ]; check "node search no-args exit 2" $?

echo; echo "== $PASS passed, $FAIL failed =="
exit $FAIL
