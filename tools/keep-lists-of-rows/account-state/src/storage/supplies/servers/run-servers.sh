#!/bin/bash
# Run the compiled suites once per listed server and write one log per server and suite.
#   run-servers.sh <cargo target dir> <results dir> <suite,...> [label...]   (no label: every server in servers.txt)
# Suites: conformance (the parent's 13 cases), asof (the as-of case alone, with the parent's full 100,000-version history),
# roundtrips (network round trips per operation), differential (random operations against the SQLite supply). Servers
# come from servers/servers.txt; SUPPLY_HISTORY_VERSIONS, DIFFERENTIAL_STEPS, DIFFERENTIAL_SEEDS and TEST_THREADS may be set in the environment. With MANAGE_SERVERS=1 each
# server is started (data on RAM) before its suites and removed after them, so only one runs at a time.
set -u
target="$1"; results="$2"; suites="$3"; shift 3
here="$(cd "$(dirname "$0")" && pwd)"
binary() { ls -t "$target"/debug/deps/"$1"-* | grep -v '\.[a-z]*$' | head -1; }
mkdir -p "$results"
while read -r label kind url; do
  case "$label" in ''|'#'*) continue;; esac
  if [ "$#" -gt 0 ]; then
    wanted=0; for one in "$@"; do [ "$one" = "$label" ] && wanted=1; done
    [ "$wanted" = 1 ] || continue
  fi
  [ -n "${MANAGE_SERVERS:-}" ] && "$here/servers.sh" up "$label"
  for suite in ${suites//,/ }; do
    echo "== $label $suite"
    program="$suite"; filter=""; extra="--nocapture"; history="${SUPPLY_HISTORY_VERSIONS:-}"
    if [ "$suite" = asof ]; then program=conformance; filter="as_of_reads"; history=""; fi
    if [ "$suite" = conformance ]; then extra=""; fi
    STORAGE_SUPPLY="$kind" STORAGE_URL="$url" SUPPLY_HISTORY_VERSIONS="$history" "$(binary "$program")" $filter --test-threads "${TEST_THREADS:-4}" $extra > "$results/$label.$suite.log" 2>&1
    echo "exit $?" >> "$results/$label.$suite.log"
    grep -E "^test .*(FAILED)|test result|ROUNDTRIPS|^differential|as-of \(record" "$results/$label.$suite.log"
  done
  [ -n "${MANAGE_SERVERS:-}" ] && "$here/servers.sh" down "$label"
done < "$here/servers.txt"
