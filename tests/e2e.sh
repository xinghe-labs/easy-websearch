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
grep -q "engines:" /tmp/t1.out; check "node search prints engine status (stdout)" $?

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
if (names.includes('anysearch') || names.includes('keenable') || names.includes('sogouweixin')) process.exit(1);"
check "backups excluded from default set" $?

# --- baidu in default pool; searxng hidden without env ---
node scripts/search.mjs "webgpu" -n 1 --json 2>/dev/null | json "
const names = d.engines.map(e => e.name);
if (!names.includes('baidu') || names.includes('searxng')) process.exit(1);"
check "baidu in default set, searxng hidden" $?

SEARXNG_BASE_URL=http://127.0.0.1:9 node scripts/search.mjs "test" -n 1 --json 2>/dev/null | json "
const s = d.engines.find(e => e.name === 'searxng');
if (!s || s.ok !== false) process.exit(1);"
check "searxng activates with env (fails soft on bad URL)" $?

# --- doctor BYOK hints ---
node scripts/doctor.mjs 2>/dev/null | grep -q 'BRAVE_API_KEY not set — get it: brave.com/search/api'
check "doctor SKIP rows show key signup links" $?

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

# --- v1.6: --direct flag + cooldown escalation ---
# 状态文件断言统一用 node(与被测 runtime 同路径解释, git-bash 下无 python3)
METASO_API_KEY=fake node scripts/search.mjs "test" -n 1 --direct --json >/dev/null 2>&1
node -e "
const fs = require('fs');
const p = process.env.XDG_CACHE_HOME + '/easy-websearch/cooldowns.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
if (d.metaso.failures !== 1) process.exit(1);"
check "--direct flag runs and records failure" $?

node -e "
const fs = require('fs');
const p = process.env.XDG_CACHE_HOME + '/easy-websearch/cooldowns.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
d.metaso.until = 0; fs.writeFileSync(p, JSON.stringify(d));"
METASO_API_KEY=fake node scripts/search.mjs "test" -n 1 --json 2>/dev/null | json "
const m = d.engines.find(e => e.name === 'metaso');
if (!m || m.ok !== false) process.exit(1);"
node -e "
const fs = require('fs');
const p = process.env.XDG_CACHE_HOME + '/easy-websearch/cooldowns.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8')).metaso;
if (d.failures !== 2) process.exit(1);"
check "cooldown escalates on repeat failure (failures=2)" $?

EASY_WEB_SEARCH_DIRECT=1 node scripts/search.mjs "test" -n 1 --json >/dev/null 2>&1
check "EASY_WEB_SEARCH_DIRECT=1 env accepted" $?
unset XDG_CACHE_HOME

# --- P0-1: --help and flag validation ---
node scripts/search.mjs --help >/tmp/h.out 2>&1; rc=$?
[ $rc -eq 0 ] && grep -q "Usage:" /tmp/h.out; check "--help exits 0 with usage" $?
node scripts/search.mjs "test" --lanng zh >/dev/null 2>&1; [ $? -eq 2 ]; check "unknown flag exits 2" $?
node scripts/search.mjs "test" --site >/dev/null 2>&1; [ $? -eq 2 ]; check "missing value exits 2" $?

# --- P1-4: unknown engine lists valid values ---
node scripts/search.mjs "test" --engine duckduckgo 2>&1 | grep -q "Valid engines: ddg"
check "unknown engine lists valid engines" $?

# --- P2-6: days-ignored note (bing must be OK, or soft-fail for a legit reason) ---
node scripts/search.mjs "AI news" --days 7 -n 1 --json 2>/dev/null | json "
const b = d.engines.find(e => e.name === 'bing');
if (!b) process.exit(1);
if (b.ok && b.note !== 'days ignored by bing') process.exit(1);
if (!b.ok && !/junk|HTTP/.test(b.error)) process.exit(1);"; check "days-ignored note in json" $?

# --- P0-2: junk detector unit test (synthetic) ---
node --input-type=module -e "
import('./scripts/search.mjs').then(({ looksLikeJunk }) => {
  const junk = [{title:'Google',url:'https://www.google.com/'},{title:'Google',url:'https://www.google.com.hk/'},{title:'Google',url:'https://google.cn/'}];
  const good = [{title:'WebGPU API - MDN',url:'https://developer.mozilla.org/zh-CN/docs/Web/API/WebGPU_API'},{title:'Learn WebGPU',url:'https://webgpufundamentals.org/'}];
  if (looksLikeJunk(junk, 'webgpu') !== true) process.exit(1);
  if (looksLikeJunk(good, 'webgpu') !== false) process.exit(1);
});"; check "bing junk detector (synthetic)" $?

if command -v python3 >/dev/null 2>&1; then
  python3 -c "
import sys; sys.path.insert(0, 'scripts')
from search import _looks_like_junk as j
junk=[{'title':'Google','url':'https://www.google.com/'},{'title':'Google','url':'https://www.google.com.hk/'},{'title':'Google','url':'https://google.cn/'}]
good=[{'title':'WebGPU API - MDN','url':'https://developer.mozilla.org/zh-CN/docs/Web/API/WebGPU_API'},{'title':'Learn WebGPU','url':'https://webgpufundamentals.org/'}]
assert j(junk,'webgpu') is True and j(good,'webgpu') is False"
  check "py junk detector (synthetic)" $?
fi

# --- setup: one-command onboarding (isolated target) ---
SETUP_TARGET="$(mktemp -d)"
node scripts/setup.mjs --dir "$SETUP_TARGET" >/tmp/setup.out 2>&1
[ -f "$SETUP_TARGET/easy-websearch/SKILL.md" ] && [ -f "$SETUP_TARGET/easy-websearch/scripts/doctor.mjs" ]
check "setup installs skill folder" $?
grep -q "engines OK:" /tmp/setup.out; check "setup runs doctor from installed copy" $?
node scripts/setup.mjs --dir "$SETUP_TARGET" 2>&1 | grep -q "updated"
check "setup second run updates in place" $?
node scripts/setup.mjs --list >/dev/null 2>&1; check "setup --list exits 0" $?
rm -rf "$SETUP_TARGET"

echo; echo "== $PASS passed, $FAIL failed =="
exit $FAIL
