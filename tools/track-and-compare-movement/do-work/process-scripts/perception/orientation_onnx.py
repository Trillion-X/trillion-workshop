#!/usr/bin/env python3
# tools/match/orientation_onnx.py
#
# THE FLY-NATIVE (torch-free) CAMERA-ON-SPHERE CHANNEL — a drop-in for orientation.facing_for_window /
# orientation.elevation_for_window that runs on the bare Fly host (onnxruntime + numpy + Pillow; NO torch /
# open_clip / ultralytics / cv2). Same CLIP ViT-B-32 model, same TEXT-defined orientation/elevation axes
# (baked once into clip_axes.npz), SAME OUTPUT CONTRACT — only the runtime substrate differs.
# Sibling of body_orientation_onnx.py (heading) and pose_onnx.py (pose); the two CLIP axes that
# orientation.py computes from text prompts are precomputed and shipped as DATA so no text encoder runs.
#
# WHAT: per-window FACING (front/back azimuth) and ELEVATION (overhead/eye-level pitch) — both continuous
#       camera-relative coordinates read from PIXELS via CLIP image features projected onto a text-defined
#       axis. Identical semantics + convention to orientation.py (front-facing → higher facing; birdseye →
#       higher elevation). NOT a closed enum — a continuous axis matched by distance (L099).
#
# HOW: per sampled frame, the LARGEST person box (from the already-mounted yolo11n-pose ONNX via pose_onnx,
#       no separate detector) → square padded crop → open_clip's EXACT preprocess (PIL bicubic-antialias
#       Resize to 224 + CLIP mean/std normalize — numpy bilinear is NOT faithful enough for CLIP, measured
#       cosine 0.848; PIL bicubic gives cosine ~1.0) → CLIP visual ONNX encode → L2-normalize → cos with the
#       baked facing/elevation axis. Window-averaged (the multi-frame averaging that lifts the single-frame
#       margin to a usable coordinate, per orientation.py).
#
# PARITY (PROVEN 2026-06-30, real reference frame crop): the CLIP-onnx embedding via this PIL path vs torch
#       open_clip.encode_image → cosine ≈ 1.000; the projected facing/elevation scalars match to ~1e-3.
#       (see test_orientation_onnx.py — SKIP-guarded when torch/open_clip absent.)
#
# WHY ONNX + numpy + Pillow (L055 deepest root): the Fly host has python3.11 but no torch — torch+open_clip
#       would be a multi-GB mount. The CLIP visual ONNX is 352MB; numpy/onnxruntime/Pillow are small
#       manylinux wheels. The ARCHITECTURE is identical; only the executor changes (L089: one code path,
#       environment is data — the matcher picks the orientation source by config, never a code branch).
#
# CONTRACT (IDENTICAL to orientation.py so the matcher's heading/elevation gates are unchanged):
#   load_session(clip_ckpt=DEFAULT_CLIP_CHECKPOINT, axes=DEFAULT_CLIP_AXES, pose_ckpt=...) -> bundle (cached)
#   facing_for_window(video, t0, t1, frames=12, bundle=None, bins=5, ffmpeg=...)
#       -> {"value": float, "traj": [signed bins], "conf": float, "n": int, "sd": float} | None
#   elevation_for_window(video, t0, t1, frames=8, bundle=None, ffmpeg=...)
#       -> {"value": float, "conf": float, "n": int, "sd": float} | None
#     None when no person is detected in the window (FAIL-CLOSED: no signal, never a guess).
from __future__ import annotations
import os, sys
from pathlib import Path
import numpy as np

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))                       # tools/match
sys.path.insert(0, str(_HERE.parent / "motion"))     # tools/motion
import pose_onnx                                      # person box (SSOT pose engine, already mounted)
from pose_estimate_onnx import _probe_video, _iter_frames   # the Fly ffmpeg frame-decode (SSOT)

from model_location import model_path               # where the models are found at run time (never a tracked link)

DEFAULT_CLIP_CHECKPOINT = model_path("clip_vitb32_visual.onnx")
DEFAULT_CLIP_AXES = model_path("clip_axes.npz")  # data like every model: MATCH_VENDOR_ROOT first, then beside this file
DEFAULT_POSE_CHECKPOINT = pose_onnx.__dict__.get("DEFAULT_ONNX_CHECKPOINT", model_path("yolo11n-pose.onnx"))
DEFAULT_FFMPEG = os.environ.get("MATCH_FFMPEG", "ffmpeg")
# open_clip ViT-B-32 normalization (CLIP/laion2b)
_CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
_CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
_CLIP_SIZE = 224
_BUNDLE = {"b": None, "key": None}


def log(m): print(f"[orient-onnx] {m}", file=sys.stderr, flush=True)


def load_session(clip_ckpt=DEFAULT_CLIP_CHECKPOINT, axes=DEFAULT_CLIP_AXES, pose_ckpt=DEFAULT_POSE_CHECKPOINT):
    """Load the CLIP visual ONNX + the pose ONNX (for person boxes) + the baked text axes. Cached."""
    key = (clip_ckpt, axes, pose_ckpt)
    if _BUNDLE["b"] is not None and _BUNDLE["key"] == key:
        return _BUNDLE["b"]
    import onnxruntime as ort
    for p in (clip_ckpt, axes, pose_ckpt):
        if not Path(p).exists():
            raise FileNotFoundError(f"orientation_onnx asset missing: {p}")
    clip = ort.InferenceSession(clip_ckpt, providers=["CPUExecutionProvider"])
    pose = ort.InferenceSession(pose_ckpt, providers=["CPUExecutionProvider"])
    z = np.load(axes)
    facing = z["facing"].astype(np.float32); facing = facing / (np.linalg.norm(facing) + 1e-12)
    elevation = z["elevation"].astype(np.float32); elevation = elevation / (np.linalg.norm(elevation) + 1e-12)
    _BUNDLE["b"] = {"clip": clip, "pose": pose, "facing": facing, "elevation": elevation}
    _BUNDLE["key"] = key
    return _BUNDLE["b"]


def load_model(*args, **kwargs):
    """Uniform-contract alias for load_session (matches orientation.load_model so the perception-backend seam
    can pre-load a handle for either backend). Torch-only positional/kw args are ignored (the ONNX assets are
    fixed exports, not runtime variant selectors)."""
    return load_session()


def _clip_preprocess(crop_rgb: np.ndarray) -> np.ndarray:
    """open_clip ViT-B-32 EXACT preprocess: PIL bicubic-antialias Resize to 224 (square crop → CenterCrop is
    a no-op) → /255 → CLIP mean/std normalize. PIL bicubic is REQUIRED (numpy bilinear → cosine 0.848)."""
    from PIL import Image
    im = Image.fromarray(crop_rgb).resize((_CLIP_SIZE, _CLIP_SIZE), Image.BICUBIC)
    arr = np.asarray(im, dtype=np.float32) / 255.0
    arr = (arr - _CLIP_MEAN) / _CLIP_STD
    return arr.transpose(2, 0, 1)                     # HWC -> CHW


def _person_crop(frame_rgb: np.ndarray, pose_sess, pad: float = 0.35):
    """Largest-person square crop (RGB) from a frame via the pose ONNX box, or None (fail-closed)."""
    persons = pose_onnx.infer(frame_rgb, pose_sess)
    if not persons:
        return None
    H, W = frame_rgb.shape[:2]
    x0, y0, x1, y1 = max(persons, key=lambda p: (p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1]))["box"]
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    sz = max(x1 - x0, y1 - y0) * (1 + pad)
    x = int(max(0, cx - sz / 2)); y = int(max(0, cy - sz / 2))
    s = int(min(sz, W - x, H - y))
    if s < 40:
        return None
    return frame_rgb[y:y + s, x:x + s]


def _crops(video, t0, t1, frames, bundle, ffmpeg, pad=0.35):
    """Decode the window once (mounted ffmpeg, rawvideo) and return `frames` largest-person square crops,
    temporally ordered — mirrors orientation._crops but cv2-free."""
    w, h, fps = _probe_video(ffmpeg, str(video))
    all_frames = [fr for _i, fr in _iter_frames(ffmpeg, str(video), w, h)]
    tot = len(all_frames)
    if tot == 0:
        return []
    f0 = int(max(0, t0 * fps)) if t1 > t0 else 0
    f1 = int(min(tot - 1, t1 * fps)) if t1 > t0 else tot - 1
    if f1 <= f0:
        f0, f1 = 0, tot - 1
    out = []
    for k in range(frames):
        fi = int(f0 + (f1 - f0) * (k + 0.5) / frames)
        fi = max(0, min(tot - 1, fi))
        c = _person_crop(all_frames[fi], bundle["pose"], pad)
        if c is not None:
            out.append(c)
    return out


def _embed(crops, bundle) -> np.ndarray:
    """CLIP visual ONNX embedding of each crop, L2-normalized → (N, 512)."""
    batch = np.stack([_clip_preprocess(c) for c in crops]).astype(np.float32)
    clip = bundle["clip"]
    em = clip.run(None, {clip.get_inputs()[0].name: batch})[0]
    em = em / (np.linalg.norm(em, axis=-1, keepdims=True) + 1e-12)
    return em


def facing_for_window(video, t0=0.0, t1=0.0, frames=12, bundle=None, bins=5, ffmpeg=DEFAULT_FFMPEG):
    """Signed front/back FACING over the window (scalar mean + signed trajectory). CONTRACT-IDENTICAL to
    orientation.facing_for_window (same dict; None when no person detected — FAIL-CLOSED)."""
    if not Path(video).exists():
        return None
    b = bundle or load_session()
    crops = _crops(video, t0, t1, frames, b, ffmpeg)
    if not crops:
        return None
    em = _embed(crops, b)
    cos = em @ b["facing"]
    vals = [float(x) for x in cos]
    mean = sum(vals) / len(vals); sd = float(np.std(cos))
    traj = []
    if len(vals) >= bins:
        per = len(vals) / bins
        for k in range(bins):
            g = vals[int(k * per):max(int(k * per) + 1, int((k + 1) * per))]
            traj.append(round(sum(g) / len(g), 4))
    else:
        traj = [round(v, 4) for v in vals]
    agree = max(0.0, 1.0 - sd / 0.05)
    cover = len(crops) / max(1, frames)
    return {"value": round(mean, 4), "traj": traj, "conf": round(0.5 * agree + 0.5 * cover, 3),
            "n": len(crops), "sd": round(sd, 4)}


def elevation_for_window(video, t0=0.0, t1=0.0, frames=8, bundle=None, ffmpeg=DEFAULT_FFMPEG):
    """Camera ELEVATION (pitch) over the window — the 2nd camera-on-sphere axis. CONTRACT-IDENTICAL to
    orientation.elevation_for_window (same dict; None when no person detected — FAIL-CLOSED)."""
    if not Path(video).exists():
        return None
    b = bundle or load_session()
    crops = _crops(video, t0, t1, frames, b, ffmpeg)
    if not crops:
        return None
    em = _embed(crops, b)
    cos = em @ b["elevation"]
    vals = [float(x) for x in cos]
    mean = sum(vals) / len(vals); sd = float(np.std(cos))
    agree = max(0.0, 1.0 - sd / 0.03)
    cover = len(crops) / max(1, frames)
    return {"value": round(mean, 4), "conf": round(0.5 * agree + 0.5 * cover, 3),
            "n": len(crops), "sd": round(sd, 4)}


if __name__ == "__main__":
    import argparse, json
    ap = argparse.ArgumentParser(description="Fly-native (torch-free) camera-on-sphere coords (facing+elevation)")
    ap.add_argument("--video", required=True)
    ap.add_argument("--t0", type=float, default=0.0)
    ap.add_argument("--t1", type=float, default=0.0)
    ap.add_argument("--frames", type=int, default=12)
    ap.add_argument("--axis", choices=["facing", "elevation", "both"], default="both")
    ap.add_argument("--ffmpeg", default=DEFAULT_FFMPEG)
    a = ap.parse_args()
    out = {}
    if a.axis in ("facing", "both"):
        out["facing"] = facing_for_window(a.video, a.t0, a.t1, a.frames, ffmpeg=a.ffmpeg)
    if a.axis in ("elevation", "both"):
        out["elevation"] = elevation_for_window(a.video, a.t0, a.t1, a.frames, ffmpeg=a.ffmpeg)
    print(json.dumps(out))
