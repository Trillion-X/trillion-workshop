#!/usr/bin/env bash
# match/orchestrate.sh — the motion-comparison MATCH process-job orchestrator (the script the workflow's
# compute.process step invokes). It runs the crown-jewel matcher entrypoint on a subject motion descriptor
# against a reference index and writes the self-describing motion-match.v1 envelope as command-output.json.
# A SEPARATE workflow step then runs make-motion-comparison-records-from-match-output.py over that envelope
# to emit the motion-comparison-result record (mirrors motion-analysis's two-compute-step pattern).
#
# CONTRACT (flag-based, named by the workflow step's argv — no positional guessing):
#   bash orchestrate.sh --subject-desc DESC[:WIN] --subject-kp KP --index INDEX --out OUTDIR
#       [--salience-config JSON] [--comparison-spec JSON]
#   --index INDEX is EITHER a directory (offline / tests / package_path mount) OR a single .tar artifact of
#   the materialized index dir (the live shape: engine mounts ONE blob_ref file, this process untars it).
#   writes "$OUTDIR/command-output.json" = motion-match.v1.
#
# This script names NO machine path. The heavy env (JOINTBDOE_VENDOR for heading + PYTHONPATH→this bundle so
# `import select_partner` resolves, L089) arrives via the compute.process step env, exactly like perception's
# orchestrate.sh. Fail-closed: run_match's own rc (2 missing inputs / 1 matcher error) propagates via set -e.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUBJECT_DESC="" SUBJECT_KP="" INDEX="" OUTDIR="." SAL="" CSPEC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --subject-desc) SUBJECT_DESC="$2"; shift 2;;
    --subject-kp)   SUBJECT_KP="$2";   shift 2;;
    --index)        INDEX="$2";        shift 2;;
    --out)          OUTDIR="$2";       shift 2;;
    --salience-config) SAL="$2";       shift 2;;
    --comparison-spec) CSPEC="$2";     shift 2;;
    *) echo "orchestrate.sh: unknown arg $1" >&2; exit 2;;
  esac
done
[ -n "$SUBJECT_DESC" ] && [ -n "$SUBJECT_KP" ] && [ -n "$INDEX" ] || { echo "orchestrate.sh: --subject-desc, --subject-kp, --index are required" >&2; exit 2; }
# --index accepts EITHER a directory (offline / tests / package_path mount) OR a single content-addressed
# artifact (a .tar of the materialized index dir, mounted via the engine's blob_ref — the proven live shape:
# the engine mounts ONE file, this process untars it; the matcher core stays dir-only). The matcher reads a
# DIR, so a tar is unpacked here into the job dir before run_match. Fail-closed: anything else is rejected.
if [ -d "$INDEX" ]; then
  : # already a directory — use as-is (byte-identical to the offline / T2b path)
elif [ -f "$INDEX" ]; then
  INDEX_DIR="$OUTDIR/_index_unpacked"
  rm -rf "$INDEX_DIR"; mkdir -p "$INDEX_DIR"
  tar -xf "$INDEX" -C "$INDEX_DIR" || { echo "orchestrate.sh: --index '$INDEX' is a file but not a readable tar" >&2; exit 2; }
  echo "[orchestrate] unpacked index artifact $INDEX -> $INDEX_DIR" >&2
  INDEX="$INDEX_DIR"
else
  echo "orchestrate.sh: --index '$INDEX' is neither a directory nor a file (fail-closed)" >&2; exit 2
fi
ARGS=(--subject-desc "$SUBJECT_DESC" --subject-kp "$SUBJECT_KP" --index "$INDEX" --out "$OUTDIR/command-output.json")
[ -n "$SAL" ]   && ARGS+=(--salience-config "$SAL")
[ -n "$CSPEC" ] && ARGS+=(--comparison-spec "$CSPEC")
# Interpreter selection (self-healing, L089/L130 — same as perception's orchestrate.sh): the vendored
# numpy>=2 wheels need CPython>=3.11, but the sandbox's ambient python3 may resolve an incompatible
# interpreter (e.g. anaconda 3.10). Discover the first interpreter that can import the vendored numpy.
select_python() {
  local c
  # run_match needs the FULL native stack, not just numpy: the match encoders/orientation import
  # torch + open_clip + ultralytics (native forward path, the default when MATCH_FORWARD is unset) and
  # cv2 + onnxruntime (onnx path). Testing `import numpy` ALONE selected python3.14 (numpy from the
  # vendored sp/ pin) which has NONE of torch/open_clip/ultralytics -> compare (step 3) died silently the
  # same way perception did (L130 sibling of the perception orchestrate.sh fix). Test each candidate in
  # ITS OWN environment (PYTHONPATH cleared) so a vendored numpy pin can't shadow an interpreter shipping a
  # coherent full stack; first candidate importing the WHOLE stack wins. Discovery list only.
  for c in "${MATCH_PYTHON:-}" /opt/homebrew/anaconda3/bin/python3 python3.12 python3.11 \
           python3.13 python3.14 /opt/homebrew/bin/python3 python3; do
    [ -z "$c" ] && continue
    if command -v "$c" >/dev/null 2>&1 \
       && PYTHONPATH="" "$c" -c "import numpy, cv2, onnxruntime, torch, open_clip, ultralytics" >/dev/null 2>&1; then
      printf '%s\n' "$c"; return 0
    fi
  done
  printf 'python3\n'
}
PY="$(select_python)"
# Run with the selected interpreter's OWN coherent stack — clear the vendored sp/ PYTHONPATH numpy pin
# (only some interpreters can load it AND it ships none of torch/open_clip/ultralytics). MATCH_VENDOR_ROOT
# (onnx models + ffmpeg) stays set.
exec env PYTHONPATH="" "$PY" "$HERE/run_match.py" "${ARGS[@]}"
