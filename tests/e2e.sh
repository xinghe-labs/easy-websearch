#!/usr/bin/env bash
# E2E test matrix for easy-websearch. Network-dependent; run manually or in CI.
# JSON assertions use node (present wherever the scripts can run).
set -u
PASS=0; FAIL=0
check() { if [ "$2" -eq 0 ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1"; fi; }

json() { node -e "
const chunks=[];process.stdin.on('data',c=>chunks.push(c));
process.stdin.on('end',()=>{const d=JSON.parse(Buffer.concat(chunks).toString());
$1
});"; }

# --- search: node, english ---
node scripts/search.mjs "rust async runtime" -n 3 >/tmp/t1.out 2>/tmp/t1.err; check "node search EN" $?
grep -q "engines:" /tmp/t1.err; check "node search prints engine status" $?

# --- search: chinese sources ---
node scripts/search.mjs "机器学习 入门" -n 3 --lang zh >/tmp/t2.out 2>/dev/null; check "search ZH" $?
grep -qE "runoob|zhihu|csdn|juejin" /tmp/t2.out; check "search ZH returns CN sources" $?

# --- json schema, both runtimes (python twin tested when python3 exists) ---
node scripts/search.mjs "webgpu" -n 3 --json 2>/dev/null | json "
const ok = d.engines && Array.isArray(d.results) &&
  d.results.every(r => ['rank','title','url','engines'].every(k => k in r));
if (!ok) process.exit(1);"; check "node search --json schema" $?

if command -v python3 >/dev/null 2>&1; then
  python3 scripts/search.py "webgpu" -n 3 --json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d['engines'] and isinstance(d['results'], list)"
  check "py search --json schema" $?
  python3 scripts/search.py "test" -n 1 --json 2>/dev/null | python3 -c "
import json,sys,os; d=json.load(sys.stdin)
keyed={'brave','tavily','serper','exa','firecrawl','bocha','metaso','linkup','ollama'}
for e in d['engines']:
    if e['name'] in keyed and not os.environ.get(e['name'].upper()+'_API_KEY'):
        raise SystemExit('keyed engine present without key: '+e['name'])"
  check "keyed engines hidden without keys (9)" $?
else
  echo "SKIP: python3 not found (py twins not asserted here)"
fi

# --- filters ---
node scripts/search.mjs "react hooks" -n 5 --site react.dev --json >/dev/null 2>&1; check "search --site runs" $?
node scripts/search.mjs "kubernetes" -n 3 --engine bing --json 2>/dev/null | json "
if (d.engines.some(e => e.name !== 'bing')) process.exit(1);"; check "--engine bing only" $?
node scripts/search.mjs "kubernetes" -n 3 --engine ddg,bing --json 2>/dev/null | json "
if (!d.engines.some(e => e.ok)) process.exit(1);"; check "multi-engine at least one ok" $?

# --- backup engines: excluded by default, opt-in works ---
node scripts/search.mjs "webgpu" -n 1 --json 2>/dev/null | json "
const names = d.engines.map(e => e.name);
if (names.includes('anysearch') || names.includes('keenable')) process.exit(1);"
check "backups excluded from default set" $?

EASY_WEB_SEARCH_ENGINES=keenable node scripts/search.mjs "webgpu" -n 1 --json 2>/dev/null | json "
if (!d.engines.map(e => e.name).includes('keenable')) process.exit(1);"
check "env opt-in enables keenable" $?

node scripts/search.mjs "webgpu tutorial" -n 2 --engine anysearch >/dev/null 2>&1; check "--engine anysearch runs" $?
node scripts/search.mjs "webgpu tutorial" -n 2 --engine keenable >/dev/null 2>&1; check "--engine keenable runs" $?

# --- fetch ---
node scripts/fetch.mjs "https://www.runoob.com/ml/ml-tutorial.html" --json 2>/dev/null | json "
if (!d.ok || d.chars < 1000) process.exit(1);"; check "node fetch direct" $?

if command -v python3 >/dev/null 2>&1; then
  python3 scripts/fetch.py "https://www.runoob.com/ml/ml-tutorial.html" --json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d['ok'] and d['chars']>1000"
  check "py fetch direct" $?
  python3 scripts/fetch.py "ftp://x" --json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d['ok'] is False"
  check "py fetch rejects bad scheme gracefully" $?
fi

node scripts/fetch.mjs "https://httpbin.org/status/403" --json 2>/dev/null | json "
if (!(d.via === 'r.jina.ai' || d.ok === false)) process.exit(1);"
check "node fetch blocked → fallback handled" $?

# --- arg validation ---
node scripts/search.mjs >/dev/null 2>&1; [ $? -eq 2 ]; check "node search no-args exit 2" $?

# --- doctor (node; python twin when python3 exists) ---
node scripts/doctor.mjs --timeout 8 >/dev/null 2>&1; rc=$?; [ $rc -le 2 ]; check "doctor.mjs runs (exit $rc)" $([ $rc -le 2 ] && echo 0 || echo 1)
node scripts/doctor.mjs --json 2>/dev/null | json "
if (!d.engines || !('summary' in d)) process.exit(1);"; check "doctor.mjs --json schema" $?
if command -v python3 >/dev/null 2>&1; then
  python3 scripts/doctor.py --json >/dev/null 2>&1; rc=$?; [ $rc -le 2 ]; check "doctor.py runs (exit $rc)" $([ $rc -le 2 ] && echo 0 || echo 1)
fi

# --- failure cooldown (isolated cache; fake key) ---
export XDG_CACHE_HOME="$(mktemp -d)"
METASO_API_KEY=fake node scripts/search.mjs "test" -n 1 --json >/dev/null 2>&1
METASO_API_KEY=fake node scripts/search.mjs "test" -n 1 --json 2>/dev/null | json "
const m = d.engines.find(e => e.name === 'metaso');
if (!m || m.ok !== false || !m.error.startsWith('skipped (cooldown')) process.exit(1);"
check "cooldown skips failed engine on next run" $?
METASO_API_KEY=fake node scripts/search.mjs "test" -n 1 --json --no-cooldown 2>/dev/null | json "
const m = d.engines.find(e => e.name === 'metaso');
if (!m || m.error.startsWith('skipped')) process.exit(1);"
check "--no-cooldown bypasses cooldown" $?
unset XDG_CACHE_HOME

echo; echo "== $PASS passed, $FAIL failed =="
exit $FAIL
