#!/usr/bin/env python3
# tools/match/body_orientation.py
#
# THE CAMERA-AZIMUTH CHANNEL (gauntlet 2026-06-18, replaces the CLIP facing scalar which PROVABLY could not
# resolve front/back in profile-dominant swings — measured: scalar axis ±0.03, multi-prompt zero-shot, AND a
# learned CLIP-embedding probe ALL failed cross-identity; a degraded chest read as back, P=0.30).
#
# WHAT: per-frame BODY HEADING in DEGREES relative to the camera — a real continuous azimuth, not a weak
#       front/back score. CONVENTION (validated on labeled Reference Player folders): ~180 = chest/face toward camera
#       (FRONT), ~0/360 = back to camera (BACK), ~90/270 = side/profile. This is the azimuth coordinate of
#       the camera-on-the-viewing-sphere; ELEVATION (birdseye) stays in orientation.py (CLIP, AUC 1.0).
#
# HOW: JointBDOE (hnuzhy/JointBDOE, YOLOv5 joint person-detector + body-orientation head, CVPR-class HBOE,
#       trained on COCO+MEBOW so it transfers across identities — which CLIP could not). One forward pass
#       gives boxes + orientation. We take the largest person, read det[:,6]*360 = heading, det[:,4] = conf.
#       augment MUST be False — test-time scale augmentation destroys temporal coherence (measured smoothness
#       55-78deg adjacent jumps with aug, 10-20deg without). Sliding circular-median smoothing removes
#       residual per-frame jitter; a real swing rotation is SMOOTH so smoothing is signal-preserving.
#
# WHY A TRAINED MODEL (L055 deepest root): front/back asymmetry lives only in appearance, and CLIP's
#       generic embedding does not encode it transferably for non-frontal views. A model TRAINED on body
#       orientation does. This is the converged answer (independent Codex + local analysis + 3 failed CLIP
#       experiments). License note: coco_* weights are trained on the MEBOW dataset (research-only); for
#       commercial release the weights must be swapped for permissive/self-trained — the ARCHITECTURE here
#       is license-independent (any heading-in-degrees source plugs in).
#
# PERF: heading computed ONCE per clip window, cached in the descriptor — O(clips), not O(pairs). MPS/GPU.
#
# CONTRACT:
#   load_model(variant="coco_l") -> bundle (cached process-global)
#   heading_for_window(video, t0, t1, frames=16, bundle=None, smooth=True)
#     -> {"traj":[deg...], "conf":[...], "value": circular_mean_deg, "n": int, "smoothness": deg} | None
#        None when no person is detected in the window (FAIL-CLOSED: no signal, never a guess).
#   circ_dist(a_deg, b_deg) -> [0,180] circular absolute distance (helper for the matcher's gate).
from __future__ import annotations
import os, sys, math
from pathlib import Path

# Vendored JointBDOE (YOLOv5 body-orientation) location. ENV IS DATA, NOT A CODE BRANCH (L089, iter98/108/112
# precedent): `JOINTBDOE_VENDOR` overrides the path so the SAME code runs from the source repo (env unset → the
# in-repo `tools/vendor/JointBDOE` fallback → byte-identical) AND from a relocated bundle / package process-job
# (env points at the deployed 194MB vendor — never copied into package source, never a path literal in code).
_VENDOR = Path(os.environ["JOINTBDOE_VENDOR"]) if os.environ.get("JOINTBDOE_VENDOR") \
    else Path(__file__).resolve().parents[1] / "vendor" / "JointBDOE"
_BUNDLE = {"b": None}

def log(m): print(f"[orient-deg] {m}", file=sys.stderr, flush=True)

def circ_dist(a, b):
    """Circular absolute distance in degrees, [0,180]. 180 = exact reversal (front vs back)."""
    d = abs(float(a) - float(b)) % 360.0
    return min(d, 360.0 - d)

def _circ_mean(degs):
    if not degs: return None
    x = sum(math.cos(math.radians(d)) for d in degs)
    y = sum(math.sin(math.radians(d)) for d in degs)
    if x == 0 and y == 0: return None
    return math.degrees(math.atan2(y, x)) % 360.0

def _circ_median(vals):
    """Circular median = the sample minimizing total circular distance to the others."""
    if not vals: return None
    return min(vals, key=lambda c: sum(circ_dist(c, x) for x in vals))

def load_model(variant="coco_l"):
    """Load JointBDOE once (cached). torch.load patched to weights_only=False (our own trusted weights;
    torch 2.6+ defaults to True which can't unpickle the YOLOv5 model class)."""
    if _BUNDLE["b"] is not None:
        return _BUNDLE["b"]
    if str(_VENDOR) not in sys.path:
        sys.path.insert(0, str(_VENDOR))
    import torch
    _orig = torch.load
    torch.load = lambda *a, **k: _orig(*a, **{**k, "weights_only": False})
    try:
        from models.experimental import attempt_load
        from utils.general import check_img_size, non_max_suppression
        from utils.augmentations import letterbox
    finally:
        torch.load = _orig
    w = _VENDOR / "weights" / f"{variant}.pt"
    if not w.exists():
        raise FileNotFoundError(f"JointBDOE weights missing: {w}")
    torch.load = lambda *a, **k: _orig(*a, **{**k, "weights_only": False})
    try:
        model = attempt_load(str(w), map_location="cpu")
    finally:
        torch.load = _orig
    # CPU-pinned (NOT a device branch). This vendored JointBDOE (YOLOv5) keeps its Detect-layer `grid` tensors as a
    # plain Python list that `.to(device)` does NOT migrate, so on MPS the forward mixes an mps input with cpu grid →
    # `RuntimeError: tensors on mps:0 and cpu`, the exception is swallowed by heading_for_window, heading becomes None,
    # and the matcher's heading gate then fail-closes EVERY candidate (no orientation = no pair) — silently killing all
    # matching (offline for fresh uploads AND live). MPS is simply unsupported by this model; CPU is the one correct
    # path (16 frames/window, fast; deterministic + portable, L089). The broken MPS branch is deleted (L030).
    dev = "cpu"
    model = model.to(dev).eval()
    stride = int(model.stride.max())
    imgsz = check_img_size(1024, s=stride)
    _BUNDLE["b"] = {"torch": torch, "model": model, "dev": dev, "stride": stride, "imgsz": imgsz,
                    "nms": non_max_suppression, "letterbox": letterbox, "variant": variant}
    return _BUNDLE["b"]

def _heading_frame(frame_bgr, b):
    """One frame -> (heading_deg, conf) for the largest detected person, or None. augment=False (coherence)."""
    torch = b["torch"]
    img = b["letterbox"](frame_bgr, b["imgsz"], stride=b["stride"], auto=True)[0]
    img = img[:, :, ::-1].transpose(2, 0, 1).copy()      # BGR->RGB, HWC->CHW
    t = torch.from_numpy(img).to(b["dev"]).float() / 255.0
    with torch.no_grad():
        out = b["model"](t[None], augment=False)[0]      # augment=False is REQUIRED for temporal coherence
        det = b["nms"](out, 0.25, 0.45, num_angles=1)[0]
    if det is None or not len(det):
        return None
    det = det.cpu().numpy()
    i = max(range(len(det)), key=lambda k: (det[k][2] - det[k][0]) * (det[k][3] - det[k][1]))
    return float(det[i][6]) * 360.0, float(det[i][4])

def heading_for_window(video, t0=0.0, t1=0.0, frames=16, bundle=None, smooth=True):
    """Per-frame body heading (deg) across [t0,t1], temporally ordered. Fail-closed: None if the clip is
    gone or no person is ever detected. `smooth` applies a sliding circular-median (window 3) — a swing
    rotation is smooth, so this removes per-frame jitter without erasing the real rotation."""
    sys.path.append(str(Path(__file__).resolve().parents[1] / "perception"))  # window_frames.py has one home: perception/
    import window_frames
    if not Path(video).exists():
        return None
    b = bundle or load_model()
    fps, tot = window_frames.clip_props(str(video))
    f0 = int(max(0, t0 * fps)) if t1 > t0 else 0
    f1 = int(min(tot - 1, t1 * fps)) if t1 > t0 else tot - 1
    if f1 <= f0:
        f0, f1 = 0, tot - 1
    picked = [int(f0 + (f1 - f0) * (k + 0.5) / frames) for k in range(frames)]
    raw = [_heading_frame(fr, b) if fr is not None else None for fr in window_frames.read_frames(video, picked)]
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
    ap = argparse.ArgumentParser(description="body heading-in-degrees trajectory for a clip/window")
    ap.add_argument("--video", required=True)
    ap.add_argument("--t0", type=float, default=0.0)
    ap.add_argument("--t1", type=float, default=0.0)
    ap.add_argument("--frames", type=int, default=16)
    ap.add_argument("--variant", default="coco_l")
    a = ap.parse_args()
    load_model(a.variant)
    print(json.dumps(heading_for_window(a.video, a.t0, a.t1, a.frames)))
