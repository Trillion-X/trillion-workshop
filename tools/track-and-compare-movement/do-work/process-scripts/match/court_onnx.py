#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/court_onnx.py
#
# =============================================================================
# MP9.2 — the TORCH-FREE court detector (the inference-seam template)
# =============================================================================
# The on-device runtime (plan §10, superseded cont.37) runs the SAME canonical .py
# leaves natively AND in the browser; the ONLY thing that differs is the neural-net
# FORWARD pass. So perception must NOT hardcode torch. This is the court detector with
# the forward extracted into an INJECTED `run_model` capability:
#   - native:  an onnxruntime-python session on court_detection.onnx
#   - browser: the onnxruntime-web bridge (proven cont.38)
# Everything else — preprocess, sigmoid (numpy), threshold/HoughCircles/refine,
# homography fit — is numpy + cv2, all verified to run in Pyodide (cont.37/38). It is a
# byte-faithful replica of the vendored CourtDetectorNet.infer_model EXCEPT the forward
# is injected and sigmoid is numpy; it REUSES the vendored postprocess/homography leaves
# (refine_kps / get_trans_matrix / refer_kps) — does NOT re-own them. torch is needed
# ONLY for the one-time ONNX export, never at runtime.
# =============================================================================
from __future__ import annotations

import os
import sys

import cv2
import numpy as np

_VENDOR = os.environ.get("MATCH_VENDOR_ROOT")
if not _VENDOR:
    raise SystemExit("MATCH_VENDOR_ROOT env DATA is required — the vendored postprocess/homography "
                     "leaves + onnx live in the Society home, not package source")
sys.path.insert(0, os.path.join(_VENDOR, "TennisProject"))
from postprocess import refine_kps                        # vendored leaf — reuse
from homography import get_trans_matrix, refer_kps         # vendored leaves — reuse


def _sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def make_onnxruntime_model(onnx_path=None):
    """Native inference provider: an onnxruntime-python `run_model(inp)->out` closure.
    The browser provider is the onnxruntime-web bridge (same .onnx, parity-verified)."""
    import onnxruntime as ort
    path = onnx_path or os.path.join(_VENDOR, "onnx", "court_detection.onnx")
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])

    def run_model(inp):
        return sess.run(["output"], {"input": np.ascontiguousarray(inp, np.float32)})[0]

    return run_model


def detect_courts(frames, run_model):
    """The court keypoint + per-frame homography pipeline, identical to the vendored
    CourtDetectorNet.infer_model but provider-injected + torch-free.
    `run_model(inp[1,3,360,640] float32) -> [1,15,360,640]` (or [15,360,640]).
    Returns (matrixes, kps) — same contract the live emitter consumes via H_mats."""
    OW, OH, scale = 640, 360, 2
    matrixes_res, kps_res = [], []
    for image in frames:
        img = cv2.resize(image, (OW, OH))
        inp = (img.astype(np.float32) / 255.0)
        inp = np.rollaxis(inp, 2, 0)[None]                # [1,3,360,640]
        out = np.asarray(run_model(inp), dtype=np.float32)
        out = out[0] if out.ndim == 4 else out            # [15,360,640]
        pred = _sigmoid(out)

        points = []
        for k in range(14):
            heatmap = (pred[k] * 255).astype(np.uint8)
            _, heatmap = cv2.threshold(heatmap, 170, 255, cv2.THRESH_BINARY)
            circles = cv2.HoughCircles(heatmap, cv2.HOUGH_GRADIENT, dp=1, minDist=20,
                                       param1=50, param2=2, minRadius=10, maxRadius=25)
            if circles is not None:
                x_pred = circles[0][0][0] * scale
                y_pred = circles[0][0][1] * scale
                if k not in (8, 12, 9):
                    x_pred, y_pred = refine_kps(image, int(y_pred), int(x_pred), crop_size=40)
                points.append((x_pred, y_pred))
            else:
                points.append(None)

        matrix_trans = get_trans_matrix(points)
        pts = None
        if matrix_trans is not None:
            pts = cv2.perspectiveTransform(refer_kps, matrix_trans)
            matrix_trans = cv2.invert(matrix_trans)[1]
        kps_res.append(pts)
        matrixes_res.append(matrix_trans)
    return matrixes_res, kps_res
