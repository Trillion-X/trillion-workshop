#!/usr/bin/env bash
# match_perception_orchestrate.sh — the court/ball/point tracker orchestrator, pointed at
# as DATA by a motion-analysis TrackerDescriptor (submit-motion-analysis.ts:
# buildRealPerceptionDescriptor). It is the match-perception analog of the swing
# pipeline's perception/orchestrate.sh — a DIFFERENT tracker family (court/ball/bounce/
# line-call) producing facts through the SAME process-descriptor seam, ZERO edits to the
# generic motion-analysis package or the swing run_perception.py.
#
# DESCRIPTOR CONTRACT (must match buildRealPerceptionDescriptor exactly):
#   argv: bash <this-script> <clip> <cwd> <label> <requestId> [checkpoint]
#   env:  SKIP_NORMALIZE=1  MOTION_MAX_FRAMES=<n>  (+ any TrackerDescriptor.env DATA)
#   output: command-output.json (the descriptor's inline output mount, at cwd)
# The court/ball weights + TennisProject/WASB engine trees live OUTSIDE package source;
# emit_match_facts.py / wasb_infer.py resolve them from the MATCH_VENDOR_ROOT env DATA
# (supplied by TrackerDescriptor.env). The checkpoint arg is accepted but unused here
# (L089: model location is env DATA, not a path the generic package names).
set -euo pipefail
CLIP="${1:?clip path required}"          # media/source mount
CWD="${2:-.}"                            # process cwd (descriptor passes '.')
LABEL="${3:-player}"                     # subject label (unused by court/ball facts)
RID="${4:?request id required}"          # request id -> command_run_id + fact ids
# $5 = checkpoint (optional, ignored: weights are co-located DATA)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAXF="${MOTION_MAX_FRAMES:-0}"           # 0 = all frames
# The python interpreter is env DATA (TrackerDescriptor.env MATCH_PYTHON): the
# compute.process sandbox's bare `python3` has no numpy/torch/cv2, so the deployment
# supplies the interpreter that does (e.g. an anaconda/venv python). The generic
# package names no interpreter path (L089: env is data); default `python3` for a
# host that already has the deps on PATH.
PY="${MATCH_PYTHON:-python3}"

exec "$PY" "$HERE/emit_match_facts.py" "$CLIP" "$CWD/command-output.json" "$RID" "$MAXF"
