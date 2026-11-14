#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/gen_court_onnx_fixture.py
#
# MP9.2 oracle: the Python-onnxruntime reference for the on-device bridge probe.
# Builds a DETERMINISTIC input (the SAME integer formula the .mjs probe regenerates),
# runs court_detection.onnx via Python onnxruntime, and writes the 15 court keypoints
# (per-channel argmax) as `_court_fixture.json` in the onnx dir. The browser-side
# probe (pyodide_onnx_bridge_probe.mjs) must reproduce these exactly.
#
# Run: ONNX_DIR=$MATCH_VENDOR_ROOT/onnx python3 gen_court_onnx_fixture.py
import json
import os

import numpy as np
import onnxruntime as ort

DIR = os.environ.get("ONNX_DIR") or os.path.join(os.environ["MATCH_VENDOR_ROOT"], "onnx")
C, H, W = 3, 360, 640
xs, ys = np.arange(W), np.arange(H)
grid = xs[None, :] * 7 + ys[:, None] * 13                      # H,W (reproducible in JS)
inp = np.empty((1, C, H, W), np.float32)
for c in range(C):
    inp[0, c] = ((grid + c * 101) % 251).astype(np.float32)
out = ort.InferenceSession(os.path.join(DIR, "court_detection.onnx"),
                           providers=["CPUExecutionProvider"]).run(["output"], {"input": inp})[0]
kps = [[int(np.argmax(out[0, i])) % W, int(np.argmax(out[0, i])) // W] for i in range(out.shape[1])]
fixture = {"model": "court_detection", "input_shape": [1, C, H, W],
           "formula": "((x*7+y*13+c*101)%251)", "out_shape": list(out.shape), "keypoints": kps}
json.dump(fixture, open(os.path.join(DIR, "_court_fixture.json"), "w"))
print(f"fixture written: {kps[:3]}... out {fixture['out_shape']}")
