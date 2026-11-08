#!/usr/bin/env bash
# Parity test runner: the same assertion matrix must pass in BOTH runtimes
# (node + python twins). Network-free — safe for CI and for WAF-hot days.
#   bash tests/parity.sh
set -u
cd "$(dirname "$0")/.."
PASS=0; FAIL=0
check() { if [ "$2" -eq 0 ]; then PASS=$((PASS+1)); echo "PASS: $1"; else FAIL=$((FAIL+1)); echo "FAIL: $1"; fi; }

# node suites (pure functions + parser snapshots)
node tests/unit.mjs >/dev/null 2>&1;          check "node: unit (23 pure-fn)" $?
node tests/parsers.test.mjs >/dev/null 2>&1;  check "node: parser snapshots" $?

# python twin suites — the same matrices, byte-for-byte assertions
if command -v python3 >/dev/null 2>&1; then
  python3 tests/unit_test.py >/dev/null 2>&1;     check "python: unit (parity mirror)" $?
  python3 tests/parsers_test.py >/dev/null 2>&1;  check "python: parser snapshots (parity)" $?
else
  echo "SKIP: python suites (python3 not found)"
fi

echo "----"
echo "$PASS suites passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
