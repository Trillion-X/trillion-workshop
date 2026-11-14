#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_wasb_onnx_parity.py
#
# MP9.2 parity gate for the torch-free WASB ball detector: infer_frames with the
# onnxruntime forward (make_onnxruntime_model on wasb_ball.onnx) MUST produce the SAME
# dense ball candidates AND selected track as the native torch forward on real frames.
# Proves the inference seam (inject run_model, numpy sigmoid) is faithful to the oracle —
# so the on-device Pyodide path (same leaf, the onnxruntime-web provider) is correct by
# construction. Env-gated; SKIPs without the model tree/clip. Bounded by MATCH_TEST_MAX_FRAMES.
#
# PARITY CRITERION (cont.38 lesson): the net emits un-normalized logits; gate on the
# DERIVED quantities — (a) per-frame candidate count identical, (b) candidate pixel
# centroids identical to sub-pixel (the argmax/blob geometry is what feeds selection),
# (c) the selected track xy identical — NOT raw heatmap absolute values.
import os
import sys

import numpy as np

VENDOR = os.environ.get("MATCH_VENDOR_ROOT")
if not VENDOR:
    print("SKIP (env): MATCH_VENDOR_ROOT not set")
    sys.exit(0)
NEED = [os.path.join(VENDOR, "onnx", "wasb_ball.onnx"),
        os.path.join(VENDOR, "pretrained_weights", "wasb_tennis_best.pth.tar"),
        os.environ.get("MATCH_TEST_CLIP") or os.path.join(VENDOR, "_probe", "fed_court_720.mp4")]
missing = [p for p in NEED if not os.path.exists(p)]
if missing:
    print(f"SKIP (env): missing {', '.join(os.path.basename(m) for m in missing)}")
    sys.exit(0)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wasb_infer  # noqa: E402
from wasb_infer import infer_frames, make_onnxruntime_model  # noqa: E402

N = int(os.environ.get("MATCH_TEST_MAX_FRAMES", "12"))
frames = wasb_infer.read_frames(NEED[2], N)
assert frames, "no frames read"

# torch oracle — the native forward (default run_model=None)
cands_torch, states_torch = infer_frames(frames)

# torch-free path — onnxruntime forward injected
cands_onnx, states_onnx = infer_frames(frames, run_model=make_onnxruntime_model())

assert len(cands_torch) == len(cands_onnx) == len(frames), "candidate frame-count mismatch"
assert len(states_torch) == len(states_onnx), "state count mismatch"

# (a)+(b) candidate parity: same count + same centroids (sub-pixel) per frame
maxpix = 0.0
frames_with_cands = 0
for i, (ct, co) in enumerate(zip(cands_torch, cands_onnx)):
    assert len(ct) == len(co), f"frame {i}: candidate-count mismatch torch={len(ct)} onnx={len(co)}"
    if ct:
        frames_with_cands += 1
    for (xt, yt, st), (xo, yo, so) in zip(ct, co):
        d = max(abs(xt - xo), abs(yt - yo))
        maxpix = max(maxpix, d)
        assert d < 0.5, f"frame {i}: candidate pixel drift {d:.3f}px (torch=({xt:.2f},{yt:.2f}) onnx=({xo:.2f},{yo:.2f}))"

assert frames_with_cands > 0, "no frame produced a ball candidate in EITHER path — clip/model issue"

# (c) selected-track parity: same status + same xy per frame state
maxxy = 0.0
observed = 0
for i, (st_t, st_o) in enumerate(zip(states_torch, states_onnx)):
    assert st_t.status == st_o.status, f"frame {i}: status mismatch torch={st_t.status} onnx={st_o.status}"
    if st_t.status == "observed":
        observed += 1
    d = max(abs(st_t.xy[0] - st_o.xy[0]), abs(st_t.xy[1] - st_o.xy[1]))
    maxxy = max(maxxy, d)
    assert d < 0.5, f"frame {i}: selected-track drift {d:.3f}px"

assert observed > 0, "no observed (Viterbi-selected) ball in EITHER path — clip/model issue"
print(f"MP9.2 WASB-ONNX PARITY PASS — torch-free onnxruntime ball detector matches the torch oracle "
      f"({frames_with_cands}/{len(frames)} frames w/ candidates, {observed} observed; "
      f"max candidate drift {maxpix:.3f}px, max track drift {maxxy:.3f}px)")
