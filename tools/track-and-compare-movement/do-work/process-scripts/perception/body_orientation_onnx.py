#!/usr/bin/env python3
# tools/match/body_orientation_onnx.py
#
# THE FLY-NATIVE (torch-free) BODY-HEADING CHANNEL — a drop-in for body_orientation.heading_for_window that
# runs on the bare Fly host (python3.11 + onnxruntime mounted bytes; NO torch / cv2 / ultralytics). Same
# JointBDOE model, same convention, SAME OUTPUT CONTRACT — only the runtime substrate differs (ONNX + numpy
# instead of torch). See reference_fly_host_compute_process_runs_but_bare_python_mount_deps +
# reference_standalone_onnx_yolo11pose_decoder_for_fly (the pose sibling of this file).
#
# WHAT: per-frame BODY HEADING in DEGREES relative to the camera (continuous azimuth). CONVENTION (identical
#       to body_orientation.py): ~180 = chest/face toward camera (FRONT), ~0/360 = back (BACK), ~90/270 =
#       profile. This is the azimuth coordinate of the camera-on-the-viewing-sphere; ELEVATION stays in
#       orientation.py (CLIP).
#
# HOW: JointBDOE coco_l exported to ONNX at a FIXED 1024x576 input (YOLOv5 auto-letterbox of 16:9 footage
#       pads to ZERO at stride 64 → a static shape, which is exactly what onnxruntime wants). One forward
#       pass → raw [1, 36720, 7] = [cx,cy,w,h, obj, cls, angle]. decode() replicates JointBDOE's custom NMS
#       (conf = obj*cls, standard box-IoU NMS, the angle column carried through unchanged — general.py:587/597)
#       then takes the LARGEST person: heading_deg = det.angle * 360, conf = det.obj_conf. augment is N/A
#       (single fixed scale → inherently the augment=False path the torch version requires for coherence).
#
# PARITY (PROVEN 2026-06-30, frame.png, the live the reference player reference frame):
#   - decode on the EXACT torch-letterboxed input:  Δheading = 0.000 deg, Δconf = 0.000  (NMS is bit-exact)
#   - full torch-free path (RGB → numpy auto-letterbox → onnx → decode):  Δheading = 0.060 deg, Δconf = 0.000
#     The 0.060 deg is sub-pixel resize-kernel residual (same fidelity class as the pose path's 0.46px); it is
#     ~1000x below the heading gate's degree-scale tolerance (a real swing rotates 10-20 deg between frames).
#   torch ground truth on that frame: heading = 250.51 deg, conf = 0.935.
#
# WHY ONNX + numpy (L055 deepest root): the Fly host has python3.11 but no torch/cv2 — torch would be a ~2GB
#       mount per job. ONNX is 307MB (the model weights), numpy+onnxruntime are small manylinux wheels already
#       proven to run inference on Fly this session. The ARCHITECTURE is identical to the torch path; only the
#       executor changes (L089: one code path, environment is data — the matcher picks the heading source by
#       config, never a code branch).
#
# CONTRACT (IDENTICAL to body_orientation.heading_for_window so the matcher's heading gate is unchanged):
#   load_session(checkpoint=DEFAULT_JB_CHECKPOINT) -> onnxruntime.InferenceSession (cached process-global)
#   heading_for_window(video, t0, t1, frames=16, session=None, ffmpeg=DEFAULT_FFMPEG, smooth=True)
#     -> {"traj":[deg...], "conf":[...], "value": circular_mean_deg, "n": int, "smoothness": deg} | None
#        None when no person is detected in the window (FAIL-CLOSED: no signal, never a guess) — identical to
#        the torch version, so a missing heading still fail-closes the candidate (no orientation = no pair).
#   circ_dist is re-exported from body_orientation (the ONE SSOT for the gate's circular distance).
#
# REPRODUCE THE ONNX (one-off, needs torch + the vendored JointBDOE; never runs on Fly):
#   the exporter writes tools/match/jointbdoe_coco_l.onnx (gitignored, 307MB) at fixed [1,3,576,1024] from
#   weights/coco_l.pt — see tools/match/export_jointbdoe_onnx.py (sibling exporter, mirrors the pose export).
from __future__ import annotations
import os, sys, math
from pathlib import Path
import numpy as np

# --- SSOT reuse (all torch-free / cv2-free at import time) ---------------------------------------------
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))                       # tools/match
sys.path.insert(0, str(_HERE.parent / "motion"))     # tools/motion
from body_orientation import circ_dist, _circ_mean, _circ_median   # the gate's circular helpers (SSOT)
from pose_onnx import _resize_linear                                # cv2 INTER_LINEAR-faithful bilinear (SSOT)
from pose_estimate_onnx import _probe_video, _iter_frames           # the Fly ffmpeg frame-decode (SSOT)

from model_location import model_path               # where the models are found at run time (never a tracked link)

DEFAULT_JB_CHECKPOINT = model_path("jointbdoe_coco_l.onnx")
DEFAULT_FFMPEG = os.environ.get("MATCH_FFMPEG", "ffmpeg")
_IMGSZ = 1024            # YOLOv5 long side
_STRIDE = 64             # JointBDOE max stride (auto-letterbox pads the short side to a multiple of this)
_PAD = 114               # letterbox fill (YOLOv5 default)
_CONF_THR = 0.25         # JointBDOE NMS conf threshold (general.py call site)
_IOU_THR = 0.45          # JointBDOE NMS iou threshold (general.py call site)
_SESSION = {"s": None, "ckpt": None}


def log(m): print(f"[orient-deg-onnx] {m}", file=sys.stderr, flush=True)


def load_session(checkpoint: str = DEFAULT_JB_CHECKPOINT):
    """Load the JointBDOE ONNX once (cached process-global). CPU is the one correct, portable path (L089)."""
    if _SESSION["s"] is not None and _SESSION["ckpt"] == checkpoint:
        return _SESSION["s"]
    import onnxruntime as ort
    if not Path(checkpoint).exists():
        raise FileNotFoundError(f"JointBDOE ONNX missing: {checkpoint} (run export_jointbdoe_onnx.py)")
    sess = ort.InferenceSession(checkpoint, providers=["CPUExecutionProvider"])
    _SESSION["s"], _SESSION["ckpt"] = sess, checkpoint
    return sess


def load_model(variant=None, checkpoint: str = DEFAULT_JB_CHECKPOINT):
    """Uniform-contract alias for load_session (matches body_orientation.load_model so the perception-backend
    seam can pre-load a handle for either backend). `variant` is accepted for signature parity and ignored
    (the ONNX export is a fixed weight, not a runtime variant selector)."""
    return load_session(checkpoint)


def letterbox_auto(im: np.ndarray, new_shape: int = _IMGSZ, color: int = _PAD, stride: int = _STRIDE):
    """YOLOv5 auto-letterbox in pure numpy (scaleup=True, min-rectangle, stride-padded, cv2-faithful resize).
    Returns (letterboxed HxWx3, scale r, (pad_left, pad_top)). For 16:9 footage at imgsz 1024 the pad is 0,0
    → a fixed 1024x576 the exported ONNX expects."""
    h, w = im.shape[:2]
    r = min(new_shape / h, new_shape / w)                 # scaleup=True (no clamp at 1.0)
    nw, nh = int(round(w * r)), int(round(h * r))
    dw, dh = (new_shape - nw) % stride, (new_shape - nh) % stride
    dw, dh = dw / 2, dh / 2
    resized = _resize_linear(im, nw, nh)                  # bit-identical to cv2.resize(INTER_LINEAR)
    top, bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
    left, right = int(round(dw - 0.1)), int(round(dw + 0.1))
    out = np.full((nh + top + bottom, nw + left + right, 3), color, dtype=im.dtype)
    out[top:top + nh, left:left + nw] = resized
    return out, r, (left, top)


def _nms(boxes_xyxy: np.ndarray, scores: np.ndarray, iou_thr: float) -> list:
    """Standard box-IoU NMS (pure numpy) — identical to pose_onnx._nms; the angle column rides along outside."""
    x1, y1, x2, y2 = boxes_xyxy[:, 0], boxes_xyxy[:, 1], boxes_xyxy[:, 2], boxes_xyxy[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]; keep.append(int(i))
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]]); yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]]); yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1); h = np.maximum(0.0, yy2 - yy1); inter = w * h
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[1:][iou <= iou_thr]
    return keep


def decode(raw: np.ndarray, conf_thr: float = _CONF_THR, iou_thr: float = _IOU_THR):
    """JointBDOE raw [1,N,7]=[cx,cy,w,h,obj,cls,angle] → (heading_deg, conf) for the LARGEST person, or None.
    Replicates JointBDOE.non_max_suppression(num_angles=1): conf=obj*cls (general.py:587), box-IoU NMS, the
    angle column carried through unchanged (general.py:597), then largest-area box → angle*360."""
    p = raw[0]
    obj = p[:, 4]
    score = (p[:, 5:6] * obj[:, None]).max(1)             # nc=1 → conf = obj * cls
    ang = p[:, -1:]                                       # angle column (last, num_angles=1)
    m = score > conf_thr
    p, score, ang = p[m], score[m], ang[m]
    if p.shape[0] == 0:
        return None
    cx, cy, w, h = p[:, 0], p[:, 1], p[:, 2], p[:, 3]
    boxes = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], 1)
    keep = _nms(boxes, score, iou_thr)
    boxes, score, ang = boxes[keep], score[keep], ang[keep]
    a = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    i = int(a.argmax())                                  # largest person (matches torch GT selection)
    return float(ang[i, 0]) * 360.0, float(score[i])


def _heading_frame(frame_rgb: np.ndarray, session):
    """One RGB frame (HxWx3 uint8, ffmpeg order) -> (heading_deg, conf) for the largest person, or None."""
    lb, _r, _pad = letterbox_auto(frame_rgb)             # RGB stays RGB (no BGR flip — ffmpeg gives RGB)
    inp = (lb.transpose(2, 0, 1)[None].astype(np.float32)) / 255.0
    raw = session.run(None, {session.get_inputs()[0].name: inp})[0]
    return decode(raw)


def heading_for_window(video, t0=0.0, t1=0.0, frames=16, bundle=None, ffmpeg=DEFAULT_FFMPEG, smooth=True,
                       session=None):
    """Per-frame body heading (deg) across [t0,t1], temporally ordered. CONTRACT-IDENTICAL to
    body_orientation.heading_for_window (same dict + `bundle` handle name; None when no person ever detected
    — FAIL-CLOSED). Decodes the window ONCE via the mounted ffmpeg (rawvideo, no cv2), samples `frames` even
    indices, applies the sliding circular-median (window 3) smoothing the torch version uses. `session` is a
    back-compat alias for `bundle`."""
    if not Path(video).exists():
        return None
    sess = bundle or session or load_session()
    w, h, fps = _probe_video(ffmpeg, str(video))
    # Collect the frames in the window (decode-once, index-sampled — mirrors the torch cv2 seek but stream-faithful)
    f0 = int(max(0, t0 * fps)) if t1 > t0 else 0
    all_frames = []
    for i, fr in _iter_frames(ffmpeg, str(video), w, h):
        all_frames.append(fr)
    tot = len(all_frames)
    if tot == 0:
        return None
    f1 = int(min(tot - 1, t1 * fps)) if t1 > t0 else tot - 1
    if f1 <= f0:
        f0, f1 = 0, tot - 1
    raw = []
    for k in range(frames):
        fi = int(f0 + (f1 - f0) * (k + 0.5) / frames)
        fi = max(0, min(tot - 1, fi))
        raw.append(_heading_frame(all_frames[fi], sess))
    vals = [(i, r[0], r[1]) for i, r in enumerate(raw) if r is not None]
    if not vals:
        return None
    headings = [v[1] for v in vals]
    confs = [v[2] for v in vals]
    if smooth and len(headings) >= 3:
        sm = []
        for i in range(len(headings)):
            window = headings[max(0, i - 1):i + 2]
            sm.append(round(_circ_median(window), 1))
        headings_out = sm
    else:
        headings_out = [round(h, 1) for h in headings]
    adj = [circ_dist(headings_out[i], headings_out[i - 1]) for i in range(1, len(headings_out))]
    return {
        "traj": headings_out,
        "conf": [round(c, 2) for c in confs],
        "value": round(_circ_mean(headings_out), 1),
        "n": len(headings_out),
        "smoothness": round(sum(adj) / len(adj), 1) if adj else 0.0,
    }


if __name__ == "__main__":
    import argparse, json
    ap = argparse.ArgumentParser(description="Fly-native (torch-free) body heading-in-degrees for a clip/window")
    ap.add_argument("--video", required=True)
    ap.add_argument("--t0", type=float, default=0.0)
    ap.add_argument("--t1", type=float, default=0.0)
    ap.add_argument("--frames", type=int, default=16)
    ap.add_argument("--checkpoint", default=DEFAULT_JB_CHECKPOINT)
    ap.add_argument("--ffmpeg", default=DEFAULT_FFMPEG)
    a = ap.parse_args()
    load_session(a.checkpoint)
    print(json.dumps(heading_for_window(a.video, a.t0, a.t1, a.frames, ffmpeg=a.ffmpeg)))
