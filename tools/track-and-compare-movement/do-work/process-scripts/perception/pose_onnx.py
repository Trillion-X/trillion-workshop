#!/usr/bin/env python3
# tools/match/pose_onnx.py
#
# PURPOSE: Standalone YOLO11-pose inference via onnxruntime — NO torch, NO ultralytics, NO cv2.
#          Numpy + Pillow only, so it runs on the bare Fly host (proven 2026-06-29) with the
#          CV runtime delivered as mounted bytes (numpy + onnxruntime manylinux wheels + this
#          ONNX model). Produces the SAME COCO-17 keypoints ultralytics' yolo11-pose produces,
#          so `pose_estimate.py` can dispatch to this engine with ZERO downstream change
#          (L069 generative primitive / L090 self-describing data — pose engine is a swappable
#          producer behind the `pose.keypoints.v1` contract).
#
# MODEL CONTRACT (yolo11n-pose.onnx, exported imgsz=640 opset=12):
#   input  images : [1,3,640,640] float32, RGB, /255, letterboxed (pad color 114)
#   output output0: [1,56,8400]  — per anchor: [cx,cy,w,h, person_conf, (x,y,vis)*17] in 640-letterbox space
#
# This module is pure perception math (a leaf): given pixels -> keypoints. No I/O policy, no cache,
# no Society vocabulary. `pose_estimate.py` owns the contract emission + cache + multi-person tracks.

from __future__ import annotations
import numpy as np
# NOTE: numpy is the ONLY hard dependency (plus onnxruntime for the session). No PIL, no cv2,
# no torch — so this loads on the bare Fly host. Callers pass an (H,W,3) RGB uint8 array;
# frame decoding is the caller's job (the pipeline decodes video → frames via the mounted ffmpeg).

# COCO-17 keypoint order is fixed by the model head; the SSOT name list lives in pose_schema.COCO.
# We emit raw [17,3] (x,y,conf) arrays in original-image pixels; the caller attaches names.
N_KP = 17


def _resize_linear(im: np.ndarray, nw: int, nh: int) -> np.ndarray:
    """cv2.INTER_LINEAR-faithful bilinear resize in pure numpy — proven BIT-IDENTICAL to
    cv2.resize(INTER_LINEAR) (max Δ = 0). Uses the half-pixel-center mapping
    src = (dst + 0.5) * (src_size / dst_size) - 0.5, no antialias. This is what ultralytics
    feeds yolo11-pose, so keypoints match (<3px max / 0.5px mean vs ultralytics) with ZERO
    cv2/torch dependency — the whole point: this must run on the bare Fly host."""
    h, w = im.shape[:2]
    xs = (np.arange(nw) + 0.5) * (w / nw) - 0.5
    ys = (np.arange(nh) + 0.5) * (h / nh) - 0.5
    x0 = np.floor(xs).astype(int); y0 = np.floor(ys).astype(int)
    wx = (xs - x0).astype(np.float32); wy = (ys - y0).astype(np.float32)
    x0c = np.clip(x0, 0, w - 1); x1c = np.clip(x0 + 1, 0, w - 1)
    y0c = np.clip(y0, 0, h - 1); y1c = np.clip(y0 + 1, 0, h - 1)
    imf = im.astype(np.float32)
    Ia = imf[np.ix_(y0c, x0c)]; Ib = imf[np.ix_(y0c, x1c)]
    Ic = imf[np.ix_(y1c, x0c)]; Id = imf[np.ix_(y1c, x1c)]
    wx_ = wx[None, :, None]; wy_ = wy[:, None, None]
    top = Ia * (1 - wx_) + Ib * wx_
    bot = Ic * (1 - wx_) + Id * wx_
    out = top * (1 - wy_) + bot * wy_
    return np.clip(np.round(out), 0, 255).astype(np.uint8)


def letterbox(img_rgb: np.ndarray, size: int = 640, pad_val: int = 114):
    """Resize keeping aspect ratio, pad to (size,size). Returns (padded_uint8, scale, pad_x, pad_y).
    Mirrors ultralytics LetterBox(auto=False, scaleFill=False, center=True) — same geometry
    (scale = min, integer center pad) AND same resize kernel (cv2 INTER_LINEAR via _resize_linear)."""
    h, w = img_rgb.shape[:2]
    scale = min(size / w, size / h)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    resized = _resize_linear(img_rgb, nw, nh)
    canvas = np.full((size, size, 3), pad_val, dtype=np.uint8)
    pad_x = (size - nw) // 2
    pad_y = (size - nh) // 2
    canvas[pad_y:pad_y + nh, pad_x:pad_x + nw] = resized
    return canvas, scale, pad_x, pad_y


def preprocess(img_rgb: np.ndarray, size: int = 640):
    """Image (H,W,3 RGB uint8) -> (input_tensor [1,3,size,size] float32, scale, pad_x, pad_y)."""
    padded, scale, pad_x, pad_y = letterbox(img_rgb, size)
    x = padded.astype(np.float32) / 255.0          # /255
    x = np.transpose(x, (2, 0, 1))[None, ...]       # HWC -> CHW -> NCHW
    return np.ascontiguousarray(x), scale, pad_x, pad_y


def _nms(boxes_xyxy: np.ndarray, scores: np.ndarray, iou_thr: float) -> list[int]:
    """Pure-numpy NMS. boxes [n,4] xyxy. Returns kept indices (highest score first)."""
    if len(boxes_xyxy) == 0:
        return []
    x1, y1, x2, y2 = boxes_xyxy.T
    areas = (x2 - x1).clip(0) * (y2 - y1).clip(0)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = (xx2 - xx1).clip(0)
        h = (yy2 - yy1).clip(0)
        inter = w * h
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[1:][iou <= iou_thr]
    return keep


def decode(output0: np.ndarray, scale: float, pad_x: int, pad_y: int,
           conf_thr: float = 0.25, iou_thr: float = 0.7):  # defaults = ultralytics YOLO.predict (conf .25, iou .7)
    """Decode raw model output [1,56,8400] -> list of persons, each {box_conf, keypoints:[17,3] in orig px}.
    Keypoints are mapped from 640-letterbox space back to ORIGINAL image pixels."""
    pred = output0[0]                       # [56, 8400]
    pred = pred.transpose(1, 0)             # [8400, 56]
    box = pred[:, 0:4]                      # cx,cy,w,h (640 space)
    conf = pred[:, 4]                       # person confidence
    kpts = pred[:, 5:5 + N_KP * 3].reshape(-1, N_KP, 3)  # [8400,17,3] (x,y,vis) 640 space

    m = conf >= conf_thr
    if not m.any():
        return []
    box, conf, kpts = box[m], conf[m], kpts[m]

    # cxcywh -> xyxy for NMS (640 space)
    cx, cy, w, h = box.T
    xyxy = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], axis=1)
    keep = _nms(xyxy, conf, iou_thr)

    def unpad_xy(xy):  # 640-letterbox -> original pixels
        out = xy.copy().astype(np.float64)
        out[..., 0] = (out[..., 0] - pad_x) / scale
        out[..., 1] = (out[..., 1] - pad_y) / scale
        return out

    persons = []
    for i in keep:
        kp = kpts[i].astype(np.float64).copy()
        kp[:, :2] = unpad_xy(kp[:, :2])     # rescale x,y; keep vis (col 2)
        box = unpad_xy(xyxy[i].reshape(2, 2)).reshape(4)  # person box xyxy in original px (for tracking)
        persons.append({"box_conf": float(conf[i]), "box": box, "keypoints": kp})  # kp: [17,3] (x,y,vis) orig px
    return persons


def infer(img_rgb: np.ndarray, session, conf_thr: float = 0.25, iou_thr: float = 0.7):
    """Full path: image -> onnxruntime -> decoded persons (orig-pixel COCO-17 keypoints)."""
    x, scale, pad_x, pad_y = preprocess(img_rgb)
    out = session.run(None, {session.get_inputs()[0].name: x})[0]
    return decode(out, scale, pad_x, pad_y, conf_thr, iou_thr)
