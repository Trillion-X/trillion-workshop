#!/usr/bin/env bash
# packages/interaction-program/run-tests.sh
#
# ONE green command for the whole interaction-program suite. The package mixes two
# test runners on purpose:
#   - node:test  → pure leaf/selectors/contract (zero-dep, run with `node --test`)
#   - vitest     → files importing from 'vitest' (console-selectors, emergent-communities)
# Running only ONE runner reports phantom failures for the other's files ("no test
# suite found" / "suite failed") even though every test passes under its own runner.
# This script runs each file under its correct runner and fails if EITHER runner fails.
set -uo pipefail
package_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$package_dir/../.." && pwd)"
cd "$package_dir"

node_files=(); vitest_files=()
for f in read-data/*.test.mjs do-work/*.test.mjs tests/*.test.mjs; do
  [ -e "$f" ] || continue
  if grep -q "from ['\"]vitest['\"]" "$f"; then vitest_files+=("$f"); else node_files+=("$f"); fi
done

rc=0
echo "== node:test (${#node_files[@]} files) =="
node --test "${node_files[@]}" || rc=1
echo "== vitest (${#vitest_files[@]} files) =="
vitest_root_files=()
for f in "${vitest_files[@]}"; do
  vitest_root_files+=("packages/interaction-program/$f")
done
(cd "$repo_root" && npx vitest run "${vitest_root_files[@]}") || rc=1

echo
if [ "$rc" -eq 0 ]; then echo "ALL interaction-program tests GREEN"; else echo "SOME tests FAILED"; fi
exit "$rc"
