#!/usr/bin/env python3
# tools/match/orientation.py
#
# THE FRONT/BACK GENERATIVE PRIMITIVE (gauntlet 2026-06-18 iter 5, empirically validated).
#
# WHAT: a CONTINUOUS, camera-relative body-to-camera "facing" coordinate per motion window, read
#       from PIXELS. Front-facing (camera sees chest/face) → higher; back-facing (camera sees back)
#       → lower; birdseye lowest. It is NOT a {front,back,side} classifier (that would be a closed
#       enum = Society) — it is one continuous axis, matched by distance (L099 reframe).
#
# WHY PIXELS (L055 deepest root): front/back asymmetry exists ONLY in appearance (face/chest vs
#       back-of-head/shoulder-blades/heels). Monocular 2D pose and monocular 3D-lift are front/back
#       SYMMETRIC (depth sign unrecoverable) → PROVABLY cannot resolve it (measured: 2D face_rel,
#       ear_sign, 3D torso-normal dot 0.976, BlazeFace-on-back-of-head all failed). So the orientation
#       read is FORCED to ingest pixels — it is not a taste choice.
#
# HOW (identity-invariant read from identity-bearing pixels, L097): project CLIP image features of the
#       player crop onto a TEXT-defined orientation axis built from GENERIC body-orientation prompts
#       (zero domain vocab → works for tennis, basketball, reading, anything). Raw CLIP image-image
#       similarity IS identity-contaminated (prior finding stands) — but the TEXT-PROJECTION isolates
#       the orientation semantic and is identity-invariant: measured AUC(front>back)=0.955 on labeled
#       the reference player folders, and a front-facing the person clip lands at the SAME absolute score as the reference player's
#       front view with zero retraining. Multi-frame window AVERAGING is what lifts a single-frame
#       margin (~0.02) to a usable coordinate.
#
# PERF: the facing value is computed ONCE per clip and cached in the descriptor — O(clips), never
#       O(pairs). CLIP on CPU is slow; at scale this is a GPU/precomputed-embedding concern, not an
#       architecture one. The value is just a float in self-describing data; the matcher reads it
#       generically (L090).
#
# CAMERA-ON-SPHERE: facing is ONE axis (azimuth: which way the body faces the camera). The full camera
#   position on the viewing sphere needs a 2nd axis — ELEVATION (pitch: overhead/birdseye vs eye-level).
#   `elevation_for_window` is that axis, read the SAME query-robust way (CLIP text-projection on player
#   crops), replacing the framing-fragile monocular-3D (mediapipe/camera_sphere) read. Together they give
#   the camera's continuous position; front/back/side/birdseye/mirror are regions of this space, not enum.
#
# CONTRACT:
#   load_model() -> bundle (cached process-global)
#   facing_for_window(video, t0, t1, frames=12, bundle=None, bins=5)
#       -> {"value": float, "traj": [signed bins], "conf": float, "n": int, "sd": float} | None
#   elevation_for_window(video, t0, t1, frames=8, bundle=None)
#       -> {"value": float, "conf": float, "n": int, "sd": float} | None
#     None when the clip has no detectable person in the window (fail-closed: no signal, not a guess).
from __future__ import annotations
import sys
from pathlib import Path

def log(m): print(f"[orient] {m}", file=sys.stderr, flush=True)

# Generic body-orientation language. NO domain (tennis/sport) vocabulary — this is the property that
# makes the primitive work for ANY domain with zero per-domain code.
FRONT_PROMPTS = [
    "a photo of a person facing the camera",
    "a person seen from the front, you can see their face and chest",
    "front view of a person, chest and face visible",
    "a person looking toward the camera",
]
BACK_PROMPTS = [
    "a photo of a person facing away from the camera",
    "a person seen from behind, you can see their back and the back of their head",
    "back view of a person, back of the body visible",
    "a person with their back to the camera",
]
# ELEVATION axis (camera pitch: overhead/birdseye vs eye-level). The 2nd camera-on-sphere axis — the
# birdseye signal facing/pose can't give. CLIP text-projection is QUERY-ROBUST (appearance-based, framing
# tolerant) where monocular 3D (mediapipe) was framing-fragile. MEASURED AUC(birdseye>ground)=1.000.
# Generic camera-angle language, zero domain vocab.
ABOVE_PROMPTS = [
    "a photo taken from above looking down at a person",
    "overhead view of a person",
    "a person seen from a high angle, camera above them",
    "top-down view of a person",
]
LEVEL_PROMPTS = [
    "a photo of a person taken at eye level",
    "a person seen from the side at ground level",
    "a person filmed from a low camera on the ground",
    "eye-level view of a person",
]

_BUNDLE = {"b": None}

def load_model():
    """Load CLIP + YOLO + precompute the front−back text axis. Cached process-global."""
    if _BUNDLE["b"] is not None:
        return _BUNDLE["b"]
    import torch, open_clip
    model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k")
    tok = open_clip.get_tokenizer("ViT-B-32"); model.eval()
    with torch.no_grad():
        ft = model.encode_text(tok(FRONT_PROMPTS)); ft = ft / ft.norm(dim=-1, keepdim=True)
        bt = model.encode_text(tok(BACK_PROMPTS));  bt = bt / bt.norm(dim=-1, keepdim=True)
        axis = ft.mean(0) - bt.mean(0); axis = axis / axis.norm()
        at = model.encode_text(tok(ABOVE_PROMPTS)); at = at / at.norm(dim=-1, keepdim=True)
        lt = model.encode_text(tok(LEVEL_PROMPTS)); lt = lt / lt.norm(dim=-1, keepdim=True)
        elev_axis = at.mean(0) - lt.mean(0); elev_axis = elev_axis / elev_axis.norm()
    from ultralytics import YOLO
    yolo = YOLO("yolo11n.pt")
    _BUNDLE["b"] = {"torch": torch, "model": model, "preprocess": preprocess,
                    "axis": axis, "elev_axis": elev_axis, "yolo": yolo}
    return _BUNDLE["b"]

def _crops(video, t0, t1, frames, pad=0.35):
    """Sample `frames` evenly across [t0,t1] (whole clip if t1<=t0); YOLO largest-person crop each."""
    import cv2
    import window_frames
    fps, tot = window_frames.clip_props(str(video))
    f0 = int(max(0, t0*fps)) if t1 > t0 else 0
    f1 = int(min(tot-1, t1*fps)) if t1 > t0 else tot-1
    if f1 <= f0: f0, f1 = 0, tot-1
    b = load_model()["yolo"]; out = []
    picked = [int(f0 + (f1-f0) * (k + 0.5) / frames) for k in range(frames)]
    for fr in window_frames.read_frames(video, picked):
        if fr is None: continue
        H, W = fr.shape[:2]
        r = b(fr, classes=[0], verbose=False)[0]
        if not len(r.boxes): continue
        x0,y0,x1,y1 = max(r.boxes.xyxy.tolist(), key=lambda q:(q[2]-q[0])*(q[3]-q[1]))
        cx,cy=(x0+x1)/2,(y0+y1)/2; sz=max(x1-x0,y1-y0)*(1+pad)
        x=int(max(0,cx-sz/2)); y=int(max(0,cy-sz/2)); s=int(min(sz,W-x,H-y))
        if s < 40: continue
        out.append(cv2.cvtColor(fr[y:y+s, x:x+s], cv2.COLOR_BGR2RGB))
    return out

def facing_for_window(video, t0=0.0, t1=0.0, frames=12, bundle=None, bins=5):
    """Signed front/back FACING over the window. Returns the scalar mean (front/back family) AND a
    `traj` of `bins` signed values across the swing (prep→follow). The TRAJECTORY is what matters: a
    swing is a ROTATION, so the DIRECTION of facing-over-time (chest→back vs back→chest) is the
    rotation-as-seen-by-camera signal. Matching on the scalar alone paired REVERSED rotations (measured).
    One video pass: sample `frames` across the window (temporally ordered), embed, project, then bin
    into `bins` contiguous groups for the trajectory."""
    if not Path(video).exists(): return None
    b = bundle or load_model()
    torch = b["torch"]
    crops = _crops(video, t0, t1, frames)            # temporally ordered across [t0,t1]
    if not crops: return None
    from PIL import Image
    with torch.no_grad():
        ims = torch.stack([b["preprocess"](Image.fromarray(c)) for c in crops])
        em = b["model"].encode_image(ims); em = em / em.norm(dim=-1, keepdim=True)
        cos = (em @ b["axis"])
    vals = [float(x) for x in cos]
    mean = sum(vals)/len(vals); sd = float(cos.std())
    # bin temporally into `bins` contiguous groups -> signed facing trajectory
    traj = []
    if len(vals) >= bins:
        per = len(vals)/bins
        for k in range(bins):
            g = vals[int(k*per):max(int(k*per)+1, int((k+1)*per))]
            traj.append(round(sum(g)/len(g), 4))
    else:
        traj = [round(v,4) for v in vals]            # too few frames: raw series
    agree = max(0.0, 1.0 - sd/0.05)
    cover = len(crops)/max(1, frames)
    return {"value": round(mean,4), "traj": traj, "conf": round(0.5*agree + 0.5*cover, 3),
            "n": len(crops), "sd": round(sd,4)}

def elevation_for_window(video, t0=0.0, t1=0.0, frames=8, bundle=None):
    """Camera ELEVATION (pitch) over the window — the 2nd camera-on-sphere axis. Same CLIP-crop read as
    facing, projected onto the overhead−eyelevel text axis: birdseye → positive, eye/ground level →
    negative. MEASURED clean: AUC(birdseye>ground)=1.000, birdseye in [+0.014,+0.029], all ground < 0,
    and a framing-degraded wide query still reads strongly negative (ground) — i.e. QUERY-ROBUST, unlike
    the monocular-3D (mediapipe) read it replaces. Fail-closed: None when no person is detected."""
    if not Path(video).exists(): return None
    b = bundle or load_model()
    torch = b["torch"]
    crops = _crops(video, t0, t1, frames)
    if not crops: return None
    from PIL import Image
    with torch.no_grad():
        ims = torch.stack([b["preprocess"](Image.fromarray(c)) for c in crops])
        em = b["model"].encode_image(ims); em = em / em.norm(dim=-1, keepdim=True)
        cos = (em @ b["elev_axis"])
    vals = [float(x) for x in cos]
    mean = sum(vals)/len(vals); sd = float(cos.std())
    agree = max(0.0, 1.0 - sd/0.03)
    cover = len(crops)/max(1, frames)
    return {"value": round(mean,4), "conf": round(0.5*agree + 0.5*cover, 3),
            "n": len(crops), "sd": round(sd,4)}

if __name__ == "__main__":
    import argparse, json
    ap = argparse.ArgumentParser(description="camera-on-sphere coordinates (facing + elevation) for a clip/window")
    ap.add_argument("--video", required=True); ap.add_argument("--t0", type=float, default=0.0)
    ap.add_argument("--t1", type=float, default=0.0); ap.add_argument("--frames", type=int, default=12)
    ap.add_argument("--axis", choices=["facing","elevation","both"], default="both")
    a = ap.parse_args()
    out = {}
    if a.axis in ("facing","both"):    out["facing"] = facing_for_window(a.video, a.t0, a.t1, a.frames)
    if a.axis in ("elevation","both"): out["elevation"] = elevation_for_window(a.video, a.t0, a.t1, a.frames)
    print(json.dumps(out))
