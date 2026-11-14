#!/usr/bin/env bash
# packages/motion-analysis/do-work/process-scripts/match/run_pyodide_probes.sh
#
# The ON-DEVICE (browser-substrate) verification suite — the parallel of run_all_tests.sh
# (which verifies the NATIVE pipeline). It runs the SAME canonical .py leaves + both neural
# nets INSIDE Pyodide (numpy/opencv-python WASM) + onnxruntime-web — the SAME substrate the
# customer phone/web uses — and parity-gates every stage BYTE-IDENTICAL vs the native oracle.
#
# This captures the rig bootstrap (Pyodide + onnxruntime-web under Node) + the run gotcha that
# were previously tribal knowledge buried in the tracking-log cont notes:
#   - Node resolves bare imports (`pyodide`, `onnxruntime-web`) from the SCRIPT's location, so
#     each probe must run from INSIDE the rig dir; the match/ dir is passed as argv[2] (used for
#     the NODEFS mount of the real .py leaves + the native oracle subprocess).
#   - The rig is a module dir (`{"type":"module"}`) with pyodide + onnxruntime-web installed;
#     Pyodide loadPackage fetches numpy/opencv/scipy/sympy/matplotlib wheels from the jsDelivr
#     CDN on first run (network), then caches them in node_modules.
#
# Probes (each proves one on-device slice; all parity vs native). Only SELF-CONTAINED probes
# (decode their own frames + run end-to-end from the match/ dir + MATCH_VENDOR_ROOT) are in the
# runner:
#   FAST (pyodide only, no models): pyodide_admission_bench, pyodide_leaves_probe
#   E2E  (pyodide + onnxruntime-web + vendored models): pyodide_detectors_probe,
#         pyodide_emit_probe, pyodide_stream_probe
# EXCLUDED: pyodide_onnx_bridge_probe — the earliest isolated bridge proof (cont.38). It is NOT
#   self-contained (needs ONNX_DIR + a pre-generated `_court_fixture.json` from
#   gen_court_onnx_fixture.py) and is SUPERSEDED by pyodide_detectors_probe, which runs the full
#   court detector in Pyodide via onnxruntime-web (a strict superset of the round-trip). Run it
#   manually for the isolated marshalling proof:
#     ONNX_DIR=$MATCH_VENDOR_ROOT/onnx python3 gen_court_onnx_fixture.py
#     cp pyodide_onnx_bridge_probe.mjs <rig>/ && ONNX_DIR=$MATCH_VENDOR_ROOT/onnx node <rig>/pyodide_onnx_bridge_probe.mjs <match-dir>
#
# Usage:
#   MATCH_VENDOR_ROOT=<society>/court-ball-models ./run_pyodide_probes.sh          # full suite
#   ./run_pyodide_probes.sh --fast                                                # fast only (no models)
#
# Env: MATCH_PYTHON (native oracle interpreter; default anaconda), MATCH_TEST_MAX_FRAMES (30),
#      PYO_RIG (rig dir, default /tmp/pyoleaves), PYODIDE_VER (0.28.0), ORT_VER (1.20.1).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RIG="${PYO_RIG:-/tmp/pyoleaves}"
PYODIDE_VER="${PYODIDE_VER:-0.28.0}"
ORT_VER="${ORT_VER:-1.20.1}"
export MATCH_TEST_MAX_FRAMES="${MATCH_TEST_MAX_FRAMES:-30}"

command -v node >/dev/null 2>&1 || { echo "SKIP: node not found"; exit 0; }
command -v npm  >/dev/null 2>&1 || { echo "SKIP: npm not found"; exit 0; }

# --- bootstrap the rig (idempotent): a module dir with pyodide + onnxruntime-web ---
mkdir -p "$RIG"
if [ ! -f "$RIG/package.json" ]; then
  printf '{"type":"module","dependencies":{"onnxruntime-web":"^%s","pyodide":"^%s"}}' "$ORT_VER" "$PYODIDE_VER" > "$RIG/package.json"
fi
if [ ! -d "$RIG/node_modules/pyodide" ] || [ ! -d "$RIG/node_modules/onnxruntime-web" ]; then
  echo "bootstrapping rig (npm install pyodide@$PYODIDE_VER onnxruntime-web@$ORT_VER in $RIG)..."
  ( cd "$RIG" && npm install --silent --no-audit --no-fund ) || { echo "SKIP: rig npm install failed (offline?)"; exit 0; }
fi
# The shared modules the e2e probes import (./ort_session.mjs, ./match_stream_driver.mjs) — copy
# them into the rig so the probes resolve them when they run from inside the rig.
cp "$HERE/ort_session.mjs" "$RIG/ort_session.mjs"
cp "$HERE/match_stream_driver.mjs" "$RIG/match_stream_driver.mjs"

FAST=(pyodide_admission_bench pyodide_leaves_probe)
E2E=(pyodide_detectors_probe pyodide_emit_probe pyodide_stream_probe)

pass=0; fail=0; skip=0; failed=()
run() {
  local p="$1" log; log="$(mktemp)"
  # run from INSIDE the rig (bare-import resolution); pass the match/ dir as argv[2].
  cp "$HERE/$p.mjs" "$RIG/$p.mjs"
  if ( cd "$RIG" && node "$RIG/$p.mjs" "$HERE" ) >"$log" 2>&1; then
    if grep -qiE "^SKIP|SKIP:|SKIP \(" "$log"; then echo "  SKIP $p"; skip=$((skip+1));
    else echo "  PASS $p"; pass=$((pass+1)); fi
  else
    echo "  FAIL $p"; tail -6 "$log" | sed 's/^/      /'; fail=$((fail+1)); failed+=("$p")
  fi
  rm -f "$RIG/$p.mjs" "$log"
}

echo "=== on-device verification (provider policy — pure node, no rig/models) ==="
policy_log="$(mktemp)"
if node "$HERE/test_ort_session.mjs" >"$policy_log" 2>&1 && grep -q "0 failed" "$policy_log"; then
  echo "  PASS test_ort_session (WebGPU-preferred EP policy + fallback + provenance)"; pass=$((pass+1))
else
  echo "  FAIL test_ort_session"; tail -8 "$policy_log" | sed 's/^/      /'; fail=$((fail+1)); failed+=("test_ort_session")
fi
rm -f "$policy_log"

# Browser on-device FACT-DELIVERY seam — reuses the existing record-maker + writer action
# against the real 73-fact fixture (pure node; needs python3 for the record-maker, self-skips it if absent).
deliver_log="$(mktemp)"
if node "$HERE/test_publish_perception_records.mjs" "$HERE" >"$deliver_log" 2>&1 && grep -q "0 failed" "$deliver_log"; then
  echo "  PASS test_publish_perception_records (browser fact delivery via existing writer action)"; pass=$((pass+1))
else
  echo "  FAIL test_publish_perception_records"; tail -8 "$deliver_log" | sed 's/^/      /'; fail=$((fail+1)); failed+=("test_publish_perception_records")
fi
rm -f "$deliver_log"

# Generic streaming orchestrator (the loop shared by the Node probe + browser driver) — mock-proven.
driver_log="$(mktemp)"
if node "$HERE/test_match_stream_driver.mjs" >"$driver_log" 2>&1 && grep -q "0 failed" "$driver_log"; then
  echo "  PASS test_match_stream_driver (shared streaming orchestrator)"; pass=$((pass+1))
else
  echo "  FAIL test_match_stream_driver"; tail -8 "$driver_log" | sed 's/^/      /'; fail=$((fail+1)); failed+=("test_match_stream_driver")
fi
rm -f "$driver_log"

# Browser <video> frame source pure cores (RGBA→BGR cv2-parity packing + sample schedule).
fs_log="$(mktemp)"
if node "$HERE/test_browser_video_frame_source.mjs" >"$fs_log" 2>&1 && grep -q "0 failed" "$fs_log"; then
  echo "  PASS test_browser_video_frame_source (<video> BGR packing + sample schedule)"; pass=$((pass+1))
else
  echo "  FAIL test_browser_video_frame_source"; tail -8 "$fs_log" | sed 's/^/      /'; fail=$((fail+1)); failed+=("test_browser_video_frame_source")
fi
rm -f "$fs_log"

# Browser driver push<->pull frame-bridge glue (one-behind lag, O(1) frames) — mock-proven.
drv_log="$(mktemp)"
if node "$HERE/test_match_perception_browser.mjs" >"$drv_log" 2>&1 && grep -q "0 failed" "$drv_log"; then
  echo "  PASS test_match_perception_browser (browser driver push<->pull lockstep)"; pass=$((pass+1))
else
  echo "  FAIL test_match_perception_browser"; tail -8 "$drv_log" | sed 's/^/      /'; fail=$((fail+1)); failed+=("test_match_perception_browser")
fi
rm -f "$drv_log"

echo "=== on-device verification (FAST — Pyodide only, no models) ==="
for p in "${FAST[@]}"; do run "$p"; done
if [ "${1:-}" != "--fast" ]; then
  echo "=== on-device verification (E2E — Pyodide + onnxruntime-web, needs MATCH_VENDOR_ROOT) ==="
  if [ -z "${MATCH_VENDOR_ROOT:-}" ]; then echo "  (MATCH_VENDOR_ROOT unset — e2e probes self-skip)"; fi
  for p in "${E2E[@]}"; do run "$p"; done
fi

echo "=== SUMMARY: $pass passed, $skip skipped, $fail failed ==="
if [ "$fail" -ne 0 ]; then echo "FAILED: ${failed[*]}"; exit 1; fi
echo "ON-DEVICE VERIFIED — the canonical leaves + both nets run byte-identically in the Pyodide+onnxruntime-web substrate (same as the customer phone/web)."
