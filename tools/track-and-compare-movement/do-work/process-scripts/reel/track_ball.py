#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/reel/track_ball.py
#
# PURPOSE: Reel-factory stage [1] `vision.ball.track` — track the ball per frame and emit
# `ball_track.v1` (bounce/contact-event timestamps) used to (a) phase-align the side-by-side overlay
# at ball-contact and (b) score the "peak moment" for clip selection. R5 model: TrackNetV4
# (arXiv:2409.14543, motion-attention fusion over the TrackNetV2/V3 U-Net base).
#
# MODEL IS DATA (L090): the checkpoint/repo is selected by env (TRACKNET_ROOT / TRACKNET_CKPT), never
# hardcoded. FAIL-CLOSED per SP5: if the TrackNetV4 weights are not present this exits non-zero with a
# machine-readable reason AND the exact install command — it NEVER emits a silent/fake ball track.
# (Ethos already has a live `ball-court` descriptor using WASB-SBDT onnx via MATCH_VENDOR_ROOT; this
# stage is the R5-named TrackNetV4 upgrade path, registered as DATA regardless of install state.)
#
# USAGE: track_ball.py --clip CLIP.mp4 --out BALL.json
from __future__ import annotations
import argparse, json, os, sys
from pathlib import Path

INSTALL = ("git clone https://github.com/TrackNetV4/TrackNetV4 $TRACKNET_ROOT && "
           "pip install tensorflow opencv-python && "
           "# download TrackNetV4 weights per repo README, then set TRACKNET_CKPT=<path>")


def log(m): print(f"[vision.ball.track] {m}", file=sys.stderr, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Reel stage vision.ball.track (TrackNetV4).")
    ap.add_argument("--clip", required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    root = os.environ.get("TRACKNET_ROOT"); ckpt = os.environ.get("TRACKNET_CKPT")
    if not root or not ckpt or not Path(ckpt).exists():
        log("REFUSED: TrackNetV4 not installed (TRACKNET_ROOT/TRACKNET_CKPT unset or missing).")
        log(f"INSTALL: {INSTALL}")
        return 3  # fail-closed: distinct rc so the workflow can branch to the WASB-SBDT ball-court fallback descriptor
    sys.path.insert(0, root)
    try:
        import track_ball_tracknetv4 as tnet  # provided by the TrackNetV4 repo once installed
        events = tnet.infer(a.clip, ckpt)     # [{frame,x,y,visible,event}]
    except Exception as e:
        log(f"REFUSED: TrackNetV4 inference failed: {e}"); return 1
    out = {"kind": "ball_track.v1", "model": "TrackNetV4 (arXiv:2409.14543)",
           "events": events, "provenance": {"confidence": 1.0, "stage": "vision.ball.track"}}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True); json.dump(out, open(a.out, "w"))
    log(f"ball track: {len(events)} frames -> {a.out}"); return 0


if __name__ == "__main__":
    raise SystemExit(main())
