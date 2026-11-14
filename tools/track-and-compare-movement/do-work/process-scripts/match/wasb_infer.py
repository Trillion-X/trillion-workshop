#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/wasb_infer.py
#
# =============================================================================
# PURPOSE — CV02 (plan §24.5.1): the dense WASB-SBDT ball candidate source
# =============================================================================
#
# Replaces the old TrackNet 3-frame heatmap + HoughCircles + 80px winner-take-all
# (which gave 13/60 + teleports) with WASB-SBDT (HRNet, MIT, `wasb_tennis_best`),
# the current buildable SOTA tennis ball detector. WASB outputs a heatmap per
# frame; we extract ALL blob peaks above threshold as TOP-K CANDIDATES (not one
# argmax), then hand them to the CV03 smoother (Viterbi peak-path + Kalman/RTS)
# which chooses the smooth track and interpolates occlusion — so a false far peak
# is rejected as a miss instead of teleporting.
#
# Reuses WASB's own model factory (models.build_model) — we do NOT re-own the
# architecture. We add only: a 3-frame window driver, a connected-component peak
# extractor (top-K), the model↔image coordinate scaling, and the CV03 hand-off.
#
# Run: python3 wasb_infer.py <video> [out.json] [max_frames]
# =============================================================================

from __future__ import annotations

import json
import os
import sys

import cv2
import numpy as np
# torch is imported LAZILY (inside load_model / the native forward) so this module is
# importable in a torch-free runtime (Pyodide on-device): there, the model FORWARD is an
# injected onnxruntime-web `run_model` and torch is never needed. torch is a one-time
# ONNX-export dependency, not a runtime one (MP9.2, cont.39/40).

# Vendored WASB-SBDT tree + weights live OUTSIDE package source — their location is
# DATA supplied by the TrackerDescriptor.env (MATCH_VENDOR_ROOT). The generic package
# names NO path (L089: env is data, not a code branch) and FAILS CLOSED if it is absent
# (SP5 — no silent fallback to a machine-specific path).
_VENDOR = os.environ.get("MATCH_VENDOR_ROOT")
if not _VENDOR:
    raise RuntimeError(
        "MATCH_VENDOR_ROOT env DATA is required (supplied by TrackerDescriptor.env) — "
        "the generic package names no model path"
    )
_SRC = os.path.join(_VENDOR, "WASB-SBDT", "src")
sys.path.insert(0, _SRC)  # so the LAZY `from models import build_model` (in load_model) resolves

from ball_state_smoother import select_path_gated, smooth  # noqa: E402  (pure numpy leaf)


def _np_sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))

WEIGHTS = os.path.join(_VENDOR, "pretrained_weights", "wasb_tennis_best.pth.tar")
WASB_CFG = os.path.join(_SRC, "configs", "model", "wasb.yaml")


def load_model(device="cpu"):
    import yaml
    import torch
    from omegaconf import OmegaConf
    from models import build_model  # WASB's own factory — reused, not re-owned (lazy: torch)
    with open(WASB_CFG) as f:
        model_cfg = yaml.safe_load(f)
    # HRNet uses attribute access (cfg.MODEL.EXTRA) AND build_model uses subscript
    # (cfg['model']['name']); OmegaConf DictConfig supports both.
    model = build_model(OmegaConf.create({"model": model_cfg}))
    ck = torch.load(WEIGHTS, map_location="cpu")
    model.load_state_dict(ck["model_state_dict"])
    model.eval().to(device)
    return model, model_cfg


def _torch_forward(model, device):
    """Native model FORWARD as a `forward(stack[1,9,288,512]) -> sigmoid heatmap[3,288,512]`
    closure — the SAME computation the original inline loop did (torch.sigmoid preserved),
    just behind the injectable seam. torch is imported here (lazy)."""
    import torch

    def forward(x):
        with torch.no_grad():
            out = model(torch.from_numpy(np.ascontiguousarray(x, np.float32)).float().to(device))
        if isinstance(out, dict):
            out = out[0] if 0 in out else list(out.values())[0]
        elif isinstance(out, (list, tuple)):
            out = out[0]
        return torch.sigmoid(out).squeeze(0).cpu().numpy()   # [3,288,512]

    return forward


def make_onnxruntime_model(onnx_path=None):
    """On-device / torch-free model FORWARD: an onnxruntime session on wasb_ball.onnx,
    returning the SAME `forward(x) -> sigmoid heatmap[3,288,512]` contract. The browser
    provider is the onnxruntime-web bridge (same .onnx, parity-verified cont.38). The
    .onnx emits raw scale-0 logits → numpy sigmoid here, matching the torch path."""
    import onnxruntime as ort
    path = onnx_path or os.path.join(_VENDOR, "onnx", "wasb_ball.onnx")
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])

    def forward(x):
        out = sess.run(["output"], {"input": np.ascontiguousarray(x, np.float32)})[0]  # [1,3,288,512] logits
        out = out[0] if out.ndim == 4 else out
        return _np_sigmoid(out)   # [3,288,512]

    return forward


# thr=0.30 on sigmoid probs: best dense yield on the birdseye clip (raw 38/60);
# the CV03 Viterbi + bounded-accel rejects the extra low-prob distractors safely.
def _peaks_from_heatmap(hm: np.ndarray, sx: float, sy: float, thr: float = 0.30, max_k: int = 4):
    """Connected-component blob centroids above `thr` = top-K candidates, scaled
    from model space to image space by (sx, sy). Score = peak value in the blob."""
    out = []
    mask = (hm > thr).astype(np.uint8)
    if mask.sum() == 0:
        return out
    n, labels = cv2.connectedComponents(mask)
    blobs = []
    for m in range(1, n):
        ys, xs = np.where(labels == m)
        score = float(hm[ys, xs].max())
        cx, cy = float(xs.mean()), float(ys.mean())
        blobs.append((cx * sx, cy * sy, score))
    blobs.sort(key=lambda b: -b[2])
    return blobs[:max_k]


def read_frames(video_path: str, max_frames: int = 0):
    cap = cv2.VideoCapture(video_path)
    frames = []
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        frames.append(fr)
        if max_frames and len(frames) >= max_frames:
            break
    cap.release()
    return frames


# --- per-frame extraction helpers (MP9.2 slice 3 STREAMING) -------------------------------
# infer_frames batches every heatmap in memory; the on-device runtime cannot (a court
# heatmap is ~13.8MB/frame → the full clip OOMs the browser). These expose the per-frame
# pieces so a STREAMING driver can run the model one frame at a time, extract the tiny
# candidates, and DISCARD the heatmap — O(1) heatmaps instead of O(N). infer_frames is
# refactored to call them, so the batch path stays byte-identical (SSOT: one impl).

def prep_frame(fr, cfg):
    """Resize ONE BGR frame to the model input + normalize + BGR→RGB. The irreducible
    per-frame prep — batch (ball_geometry) and streaming (ball_window_stream) share it
    so there is ONE prep impl, not two (SSOT)."""
    in_w, in_h = cfg["inp_width"], cfg["inp_height"]      # 512 x 288
    r = cv2.resize(fr, (in_w, in_h)).astype(np.float32) / 255.0
    return r[:, :, ::-1]  # BGR->RGB


def ball_stack_from_preps(p_prev, p_cur, p_next):
    """The `[1,9,288,512]` 3-frame-window model input from three already-prepped frames.
    The irreducible window assembly — batch and streaming share it (SSOT)."""
    stack = np.concatenate([p_prev, p_cur, p_next], axis=2)  # H,W,9
    return stack.transpose(2, 0, 1)[None]


def frame_scale(frame_shape, cfg):
    """(sx, sy) model↔image scale from a SINGLE frame's shape — so the streaming driver
    gets the scale from frame 0 without materializing the whole clip."""
    H, W = frame_shape[:2]
    return W / cfg["inp_width"], H / cfg["inp_height"]


def ball_geometry(frames, cfg):
    """(sx, sy, prep) for a frame set: the model↔image scale + the per-frame BGR→RGB
    resize/normalize closure. prep clamps the window edges to [0, n-1]."""
    n = len(frames)
    if n == 0:
        raise SystemExit("no frames")
    sx, sy = frame_scale(frames[0].shape, cfg)

    def prep(idx):
        return prep_frame(frames[min(max(idx, 0), n - 1)], cfg)

    return sx, sy, prep


def ball_input_for_frame(prep, i):
    """The `[1,9,288,512]` 3-frame-window model input for frame i (prep i-1, i, i+1)."""
    return ball_stack_from_preps(prep(i - 1), prep(i), prep(i + 1))


def stream_frames(video_path, max_frames=0):
    """GENERATOR yielding decoded BGR frames ONE AT A TIME — the streaming counterpart to
    read_frames (which materializes the whole list, ~2.76MB/frame → a full match clip OOMs
    the on-device phone). The streaming driver pulls from here (native cv2) or, in the
    browser peer, from the <video>/MediaRecorder; either way only a bounded window is alive."""
    cap = cv2.VideoCapture(video_path)
    n = 0
    try:
        while True:
            ok, fr = cap.read()
            if not ok:
                break
            yield fr
            n += 1
            if max_frames and n >= max_frames:
                break
    finally:
        cap.release()


def window_preps(prep_prev, prep_cur, prep_next):
    """The 3-prep ball window with EDGE CLAMP — the ONE place first/last-frame clamping lives:
    a missing prev (first frame) clamps to cur, a missing next (last frame) clamps to cur.
    Pass None for a neighbor that does not exist at a stream edge. Both the sync streaming
    windower (ball_window_stream, cv2-fed) AND the browser one-behind push glue call this, so the
    edge clamp is a SINGLE implementation (SSOT) and the browser stays byte-identical to native
    without re-deriving the clamp in JS (L093)."""
    return (
        prep_prev if prep_prev is not None else prep_cur,
        prep_cur,
        prep_next if prep_next is not None else prep_cur,
    )


def ball_window_stream(frame_iter, cfg):
    """Yield (i, raw_i, prep_prev, prep_cur, prep_next) one frame at a time from a frame
    GENERATOR, holding only a 3-prep sliding window + the raw current frame (for the court
    detector). Edge clamp is delegated to `window_preps` (SSOT with the browser push glue) —
    prev at i=0 == cur, next at the last frame == cur — so the assembled ball stack is
    byte-identical to the batch path while frame memory stays O(1) (the on-device requirement)."""
    it = iter(frame_iter)
    try:
        raw_cur = next(it)
    except StopIteration:
        return
    prep_cur = prep_frame(raw_cur, cfg)
    prep_prev = None                     # i=0: no prev -> window_preps clamps to cur
    i = 0
    while True:
        try:
            raw_next = next(it)
            prep_next = prep_frame(raw_next, cfg)
        except StopIteration:
            yield (i, raw_cur, *window_preps(prep_prev, prep_cur, None))  # last: next clamps to cur
            return
        yield (i, raw_cur, *window_preps(prep_prev, prep_cur, prep_next))
        prep_prev, prep_cur = prep_cur, prep_next
        raw_cur = raw_next
        i += 1


def candidates_from_heatmap(hm, sx, sy):
    """Top-K ball candidates from a sigmoid heatmap `[3,288,512]` (center channel) or
    `[288,512]`. The SAME extraction infer_frames does inline — reused, not duplicated."""
    center_hm = hm[hm.shape[0] // 2] if hm.ndim == 3 else hm  # center frame channel
    return _peaks_from_heatmap(center_hm, sx, sy)


def ball_states_from_candidates(cands_per_frame):
    """The CV03 sequence reduction (gated Viterbi select + Kalman/RTS smooth + occlusion)
    over already-extracted per-frame candidates. The streaming driver calls this once after
    the per-frame loop; the CV14c re-gate is a pure candidate FILTER + this — no model re-run."""
    selected = select_path_gated(cands_per_frame, accel_noise=4.0, meas_noise_px=3.0)
    return smooth(selected, accel_noise=4.0, meas_noise_px=3.0, occlusion_gap=5)


def infer_frames(frames, device="cpu", model_cfg=None, accept=None, run_model=None, cfg=None):
    """Dense ball-state from already-read frames (CV08 shares frames with the
    court detector — one video read). Returns (cands_per_frame, states).

    The model FORWARD is INJECTED (MP9.2): `run_model(stack[1,9,288,512]) ->
    sigmoid heatmap[3,288,512]`. Default (run_model=None) is the native torch
    forward (`_torch_forward`); the on-device runtime passes the onnxruntime
    forward (`make_onnxruntime_model`, or the onnxruntime-web bridge under
    Pyodide) so this leaf runs with ZERO torch. The leaf computes ONE canonical
    candidate/selection pipeline — only the neural call is swapped, never the
    Kalman/Viterbi/peak logic (SSOT: one impl, not two).

    `accept(frame_idx, (x, y)) -> bool` is an optional injected candidate gate
    (CV14c): when provided, a WASB peak is kept only if `accept` returns True. The
    caller supplies the predicate (e.g. a court-region test that projects the pixel
    through the per-frame homography and rejects off-court peaks) — this leaf stays
    court-agnostic (L090), exactly like the bounce detector's injected court-plane
    `accept`. Off-court detector hallucinations (measured: a 0.87-score blob 8.57m
    off-court while the ball was absent) are suppressed before selection, so the
    tracker coasts and re-acquires the true ball instead of locking the blob."""
    if run_model is not None:
        forward = run_model
        cfg = cfg or {"inp_width": 512, "inp_height": 288}
    else:
        model, c = (model_cfg or load_model(device))
        forward = _torch_forward(model, device)
        cfg = cfg or c
    sx, sy, prep = ball_geometry(frames, cfg)

    cands_per_frame = []
    for i in range(len(frames)):
        hm = forward(ball_input_for_frame(prep, i))         # sigmoid heatmap [3,288,512]
        cand = candidates_from_heatmap(hm, sx, sy)
        if accept is not None:                                # CV14c court-region gate
            # hard reject off-court peaks (incl. a frame's only candidate, so an
            # off-court blob coasts rather than locks). SAFETY is the caller's:
            # pass accept ONLY when the homography is validated reliable for this
            # clip (see the on-court-fraction calibration in the validator), else
            # a wrong court fit would delete the true ball.
            cand = [c for c in cand if accept(i, (c[0], c[1]))]
        cands_per_frame.append(cand)

    states = ball_states_from_candidates(cands_per_frame)
    return cands_per_frame, states


def infer(video_path: str, max_frames: int = 0, device="cpu"):
    """Convenience: read the video then run dense ball-state. Returns
    (frames, cands_per_frame, states)."""
    frames = read_frames(video_path, max_frames)
    cands, states = infer_frames(frames, device)
    return frames, cands, states


def main():
    video = sys.argv[1] if len(sys.argv) > 1 else "_probe/fed_court_720.mp4"
    out_json = sys.argv[2] if len(sys.argv) > 2 else "_probe/wasb_ball_state.json"
    max_frames = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    frames, cands, states = infer(video, max_frames)
    n = len(states)
    raw = sum(1 for c in cands if c)
    dense = sum(1 for s in states if s.status != "unknown")
    observed = sum(1 for s in states if s.status == "observed")
    recs = [{"frame": s.frame, "xy": list(s.xy), "status": s.status,
             "confidence": s.confidence,
             "provenance": {"model_name": "WASB-SBDT", "weights_ref": "wasb_tennis_best.pth.tar",
                            "model_version": "hrnet", "stage": "ball-track.dense.v1"}}
            for s in states]
    with open(out_json, "w") as f:
        json.dump({"kind": "perception.ball.state", "n_frames": n, "records": recs}, f)
    print(f"WASB-SBDT dense ball-state on {os.path.basename(video)}:")
    print(f"  frames: {n}")
    print(f"  raw WASB detections (>=1 candidate): {raw}/{n}  (old TrackNet+Hough = 13/60)")
    print(f"  observed (Viterbi-selected): {observed}/{n}")
    print(f"  DENSE states (observed+interpolated+occluded): {dense}/{n}")
    print(f"  wrote {out_json}")


if __name__ == "__main__":
    main()
