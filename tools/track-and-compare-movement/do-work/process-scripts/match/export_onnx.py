#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/export_onnx.py
#
# =============================================================================
# MP9 step 1 — export the perception MODELS to ONNX (the on-device runtime input)
# =============================================================================
#
# Plan §10 DECIDED the product runtime: the perception models run ON THE CUSTOMER
# DEVICE via onnxruntime-web/WebGPU, emitting the SAME perception.* facts; the
# Python pipeline becomes the accuracy ORACLE that parity-gates the ONNX port. This
# is step 1 of that: convert each torch checkpoint (resolved from MATCH_VENDOR_ROOT,
# Society home) into a portable .onnx the browser tracker loads.
#
# GENERIC mechanism (L069/L090): `export_one(spec)` exports ANY torch model from a
# DATA spec — {name, build, weights, input_shape, opset}. Adding the WASB ball model
# = ONE more MODELS entry, ZERO new export code. The ONLY model-specific bit is the
# `build` thunk (each checkpoint has its own class — unavoidable), and that is DATA
# the spec carries, not a branch in the exporter.
#
# The .onnx outputs are vendored Society artifacts → written under MATCH_VENDOR_ROOT
# (architect-societies), NOT package source (large binaries, referenced by DATA).
# The generic package names NO machine path (L089) — every location is env DATA.
#
# Run: MATCH_VENDOR_ROOT=<society>/court-ball-models python3 export_onnx.py [name...]
#      (no args = export every model; names = export only those)
# =============================================================================

from __future__ import annotations

import os
import sys

import numpy as np
import torch

_VENDOR = os.environ.get("MATCH_VENDOR_ROOT")
if not _VENDOR:
    raise SystemExit(
        "MATCH_VENDOR_ROOT env DATA is required (supplied by TrackerDescriptor.env) — "
        "the torch checkpoints + model code live in the Society home, not package source"
    )
sys.path.insert(0, os.path.join(_VENDOR, "TennisProject"))

ONNX_DIR = os.path.join(_VENDOR, "onnx")
OPSET = 17  # broad onnxruntime-web / WebGPU execution-provider support


def _read_first_frames(n):
    import cv2
    clip = os.environ.get("MATCH_TEST_CLIP") or os.path.join(_VENDOR, "_probe", "fed_court_720.mp4")
    cap = cv2.VideoCapture(clip)
    frames = []
    while len(frames) < n:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    cap.release()
    return frames


def _build_court_detector():
    """The court keypoint detector — BallTrackerNet(out_channels=15), a TrackNet-style
    fully-convolutional encoder-decoder. Standard ops only (Conv/BN/ReLU/MaxPool/
    Upsample) → exports clean. Weights: weights/court_detection.pt."""
    from tracknet import BallTrackerNet
    net = BallTrackerNet(out_channels=15)
    sd = torch.load(os.path.join(_VENDOR, "weights", "court_detection.pt"), map_location="cpu")
    net.load_state_dict(sd)
    net.eval()
    return net


def _court_input():
    """One real frame, the EXACT tensor court_detection_net.infer_model feeds:
    resize to 640x360, HWC(BGR) -> [1,3,360,640] float."""
    import cv2
    fr = _read_first_frames(1)
    if not fr:
        return None
    img = cv2.resize(fr[0], (640, 360))
    return np.rollaxis(img, 2, 0).astype("float32")[None]


def _build_wasb_ball():
    """The dense ball tracker — WASB-SBDT (HRNet), built by WASB's OWN model factory
    (reused, not re-owned). The model returns multi-scale heatmaps (dict/list); the
    live path reads scale-0, so we export a thin scale-0 wrapper to a single output."""
    import wasb_infer
    import torch.nn as nn
    model, _ = wasb_infer.load_model("cpu")

    class _Scale0(nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, x):
            o = self.m(x)
            if isinstance(o, dict):
                return o[0] if 0 in o else list(o.values())[0]
            if isinstance(o, (list, tuple)):
                return o[0]
            return o

    return _Scale0(model).eval()


def _wasb_input():
    """A 3-frame stack, the EXACT tensor wasb_infer.infer_frames feeds: each frame
    resized to 512x288, /255, BGR->RGB, concatenated on channels -> [1,9,288,512]."""
    import cv2
    fr = _read_first_frames(3)
    if len(fr) < 3:
        return None

    def prep(f):
        return (cv2.resize(f, (512, 288)).astype("float32") / 255.0)[:, :, ::-1]

    stack = np.concatenate([prep(fr[0]), prep(fr[1]), prep(fr[2])], axis=2)  # H,W,9
    return stack.transpose(2, 0, 1)[None].astype("float32")


# Per-model DATA spec — each carries its FULL contract: how to build the torch model,
# the dummy input shape (for tracing), the opset, and `make_input` (a real-frame tensor
# for the parity gate). Adding a model = ONE more entry, ZERO new export/parity code.
MODELS = [
    {
        "name": "court_detection",
        "build": _build_court_detector,
        "input_shape": (1, 3, 360, 640),
        "make_input": _court_input,
        "opset": OPSET,
    },
    {
        "name": "wasb_ball",
        "build": _build_wasb_ball,
        "input_shape": (1, 9, 288, 512),
        "make_input": _wasb_input,
        "opset": OPSET,
    },
]


def export_one(spec) -> str:
    name, build = spec["name"], spec["build"]
    shape = tuple(spec["input_shape"])
    opset = spec.get("opset", OPSET)
    os.makedirs(ONNX_DIR, exist_ok=True)
    out_path = os.path.join(ONNX_DIR, f"{name}.onnx")
    model = build()
    dummy = torch.zeros(*shape, dtype=torch.float32)
    torch.onnx.export(
        model, dummy, out_path,
        export_params=True, opset_version=opset, do_constant_folding=True,
        input_names=["input"], output_names=["output"],
        # dynamic batch so the browser tracker can run N frames in one call
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        dynamo=False,
    )
    size = os.path.getsize(out_path)
    print(f"  exported {name}: {out_path} ({size} bytes, opset {opset}, input {shape})")
    return out_path


def main():
    want = set(sys.argv[1:])
    specs = [s for s in MODELS if not want or s["name"] in want]
    if not specs:
        raise SystemExit(f"no model named {want}; known: {[s['name'] for s in MODELS]}")
    print(f"MP9 ONNX export → {ONNX_DIR}")
    for spec in specs:
        export_one(spec)
    print(f"DONE: {len(specs)} model(s) exported to ONNX")


if __name__ == "__main__":
    main()
