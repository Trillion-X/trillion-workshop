#!/usr/bin/env bash
# perception/orchestrate.sh — the motion-analysis tracker orchestrator (DATA-pointed).
#
# buildRealPerceptionDescriptor (submit-motion-analysis.ts) invokes:
#     bash <orchestratorPath> <clip> <cwd> <label> <requestId> [checkpoint]
# This adapter translates that positional contract to the crown-jewel perception entrypoint and writes
# the motion-clip-descriptor.v1 as command-output.json (the motion-analysis record-maker maps it; the
# workflow runs the record-maker itself, so SKIP_NORMALIZE mode emits only the descriptor here).
#
# JOINTBDOE_VENDOR (+ any model/path env) arrive via the descriptor env (tracker.env DATA, L089) — this
# script names NO machine path. label/requestId are unused (single-clip perception; the workflow passes
# request_id to the record-maker separately). MOTION_MAX_FRAMES (descriptor env) caps pose frames.
set -euo pipefail
CLIP="$1"; OUTDIR="${2:-.}"; CKPT="${5:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ARGS=(--clip "$CLIP" --out "$OUTDIR/command-output.json")
[ -n "$CKPT" ] && ARGS+=(--checkpoint "$CKPT")
[ -n "${MOTION_MAX_FRAMES:-}" ] && [ "${MOTION_MAX_FRAMES}" != "0" ] && ARGS+=(--max-frames "$MOTION_MAX_FRAMES")
# Model assets: model_location.py finds the onnx models under $MATCH_VENDOR_ROOT (DATA the host provides; the
# models are huge, ~670MB, and are not bundled in this scripts tar), then beside the scripts, then the build-time
# onnx folder. Nothing is linked into $HERE.
# Interpreter selection (self-healing, L089): the vendored perception wheels ($MATCH_VENDOR_ROOT/sp)
# are ABI/version-specific (numpy>=2 needs CPython>=3.11). The runtime's ambient `python3` may be an
# incompatible interpreter (e.g. a sandbox that resolves an anaconda 3.10 first), which fails with
# "No module named 'numpy._core._multiarray_umath'". Prefer an explicit interpreter supplied as DATA
# ($MATCH_PYTHON — the durable path once the vendor bundles its own python), else discover the first
# interpreter that can actually import the vendored numpy from the inherited PYTHONPATH. Names candidates
# only as a discovery list, never a single hardcoded interpreter.
select_python() {
  local c
  # The pose backend needs the FULL native stack: numpy + cv2 + ultralytics (YOLO pose runs via the
  # ultralytics library, even for an .onnx checkpoint) — testing `import numpy` ALONE is insufficient and
  # was the reel-lane silent-death root: the vendored sp/ numpy 2.5.1 pin selected python3.14 (numpy OK)
  # which has NO ultralytics -> pose-fail:rc=1 -> null descriptor. Test each candidate in ITS OWN
  # environment (PYTHONPATH cleared) so a vendored numpy pin can't shadow an interpreter that already ships
  # a coherent numpy+cv2+ultralytics stack. First candidate that imports the WHOLE stack wins. Candidates
  # are a discovery list only (never a single hardcoded interpreter); the import test decides.
  for c in "${MATCH_PYTHON:-}" /opt/homebrew/anaconda3/bin/python3 python3.12 python3.11 \
           python3.13 python3.14 /opt/homebrew/bin/python3 python3; do
    [ -z "$c" ] && continue
    if command -v "$c" >/dev/null 2>&1 \
       && PYTHONPATH="" "$c" -c "import numpy, cv2, ultralytics" >/dev/null 2>&1; then
      printf '%s\n' "$c"; return 0
    fi
  done
  printf 'python3\n'
}
PY="$(select_python)"
# Run with the selected interpreter's OWN coherent stack — clear the vendored sp/ PYTHONPATH pin, which
# forces an ABI-specific numpy 2.5.1 that only some interpreters can load AND that ships no ultralytics.
# MATCH_VENDOR_ROOT (onnx models + ffmpeg) stays set; only the numpy/site pin is dropped.
exec env PYTHONPATH="" "$PY" "$HERE/run_perception.py" "${ARGS[@]}"
