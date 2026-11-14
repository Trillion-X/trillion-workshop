#!/usr/bin/env bash
# packages/motion-analysis/do-work/process-scripts/match/run_all_tests.sh
#
# The MP10 verification gate — runs EVERY test in the ported court/ball/point
# match-perception suite and reports one consolidated pass/fail, so "every feature
# verified end-to-end" (the archive precondition) is a single command, not a memory.
#
#   FAST tests (pure leaves, no models) run unconditionally.
#   E2E tests (full perception / overlay / players / ONNX parity) need the vendored
#   model tree — set MATCH_VENDOR_ROOT to the Society home; they SKIP cleanly without it.
#
# Usage:
#   MATCH_VENDOR_ROOT=<society>/court-ball-models ./run_all_tests.sh   # full suite
#   ./run_all_tests.sh                                                 # fast only (e2e skip)
#
# Env: MATCH_PYTHON (interpreter with numpy/torch/cv2/onnxruntime; default python3),
#      MATCH_TEST_MAX_FRAMES (bounds the e2e perception; default 30).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${MATCH_PYTHON:-/opt/homebrew/anaconda3/bin/python3}"
command -v "$PY" >/dev/null 2>&1 || PY="python3"
export MATCH_TEST_MAX_FRAMES="${MATCH_TEST_MAX_FRAMES:-30}"

FAST=(test_player_coverage test_court_geometry test_shot_speed test_rally_events
      test_bounce_detect_v2 test_point_outcome test_ball_state_smoother
      test_seam_mapping test_log_filter test_window_preps test_browser_ops_parity)
E2E=(test_emit_e2e test_render_overlay test_player_positions_e2e test_onnx_parity
      test_court_onnx_parity test_wasb_onnx_parity test_emit_runtime_parity
      test_published_path_is_data test_stream_decode)

pass=0; fail=0; skip=0; failed=()

run() {
  local t="$1" log; log="$(mktemp)"
  if "$PY" "$HERE/$t.py" >"$log" 2>&1; then
    if grep -qiE "^SKIP|SKIP \(env\)" "$log"; then echo "  SKIP $t"; skip=$((skip+1));
    else echo "  PASS $t"; pass=$((pass+1)); fi
  else
    echo "  FAIL $t"; tail -5 "$log" | sed 's/^/      /'; fail=$((fail+1)); failed+=("$t")
  fi
  rm -f "$log"
}

echo "=== match-perception verification (FAST — pure leaves) ==="
for t in "${FAST[@]}"; do run "$t"; done
echo "=== match-perception verification (E2E — needs MATCH_VENDOR_ROOT) ==="
if [ -z "${MATCH_VENDOR_ROOT:-}" ]; then
  echo "  (MATCH_VENDOR_ROOT unset — e2e tests will self-skip)"
fi
for t in "${E2E[@]}"; do run "$t"; done

echo "=== SUMMARY: $pass passed, $skip skipped, $fail failed ==="
if [ "$fail" -ne 0 ]; then echo "FAILED: ${failed[*]}"; exit 1; fi
echo "ALL VERIFIED — every ported match-perception feature passes."
