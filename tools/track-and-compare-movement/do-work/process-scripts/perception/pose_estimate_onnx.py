#!/usr/bin/env python3
# tools/motion/pose_estimate_onnx.py
#
# PURPOSE: The FLY-DEPLOYABLE pose producer. Emits the EXACT same `pose.keypoints.v1` contract as
#          `pose_estimate.py`, but using ZERO heavy deps — no torch, no ultralytics, no cv2 — so it
#          runs on the bare Fly host where the CV runtime is delivered as mounted bytes (numpy +
#          onnxruntime wheels + the static ffmpeg binary + the ONNX pose model). See plan
#          `2026-06-29-fly-live-motion-comparison-pipeline` (W2) + observation
#          `2026-06-29-fly-host-compute-process-capabilities-proven.md`.
#
# WHY A SEPARATE ENTRYPOINT (not an `--engine onnx` flag on pose_estimate.py):
#   pose_estimate.py decodes with `cv2.VideoCapture` and tracks with ultralytics `model.track()` —
#   both pull torch/cv2, neither exists on Fly. This producer keeps the SAME contract but swaps:
#     - frame decode: cv2  -> the mounted static `ffmpeg` piped as raw rgb24 (numpy reshape)
#     - per-frame pose: ultralytics -> `tools/match/pose_onnx.py` (numpy-only onnxruntime decoder)
#     - tracking: ByteTrack -> a small greedy-IoU tracker (pure numpy)
#   The DOWNSTREAM (describe/match/render) consumes `pose.keypoints.v1` and never sees the engine
#   (L069 swappable producer / L090 self-describing data) — output is byte-compatible with the
#   ultralytics producer (same schema, same COCO-17 order, same rounding, same canonicalization).
#
# NON-NEGOTIABLE INVARIANTS (shared with pose_estimate.py):
#   - Output is pose.keypoints.v1 with COCO-17 keypoint order.
#   - Multi-person aware: persons[] with a stable track_id and per-frame keypoints.
#   - Content-addressed cache keyed on (full content_md5 + engine.checkpoint) — reuse, never recompute.
#
# USAGE:
#   pose_estimate_onnx.py --video IN.mp4 --out kp.json [--checkpoint yolo11n-pose.onnx]
#                         [--ffmpeg ffmpeg] [--conf 0.25] [--iou 0.7] [--max-frames N] [--no-cache]

from __future__ import annotations
import argparse, json, os, re, subprocess, sys, time
from pathlib import Path

import numpy as np

# Reuse the SSOT helpers (DRY): identity/cache from the canonical producer (safe import — pose_estimate
# lazy-imports cv2/ultralytics inside main(), so importing the module pulls in NO heavy deps), and the
# canonical pose schema. Path wiring mirrors pose_estimate.py.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))                       # tools/motion (pose_estimate)
sys.path.insert(0, str(_HERE.parent / "match"))      # tools/match  (pose_schema, pose_onnx)
from pose_estimate import fingerprint, full_content_md5, _cache_valid   # SSOT helpers
from pose_schema import COCO as COCO17, canonicalize_pose_track          # SSOT (iter75)
import pose_onnx

from model_location import model_path               # where the models are found at run time (never a tracked link)

DEFAULT_ONNX_CHECKPOINT = model_path("yolo11n-pose.onnx")


def log(m): print(f"[pose-onnx] {m}", file=sys.stderr, flush=True)


def _probe_video(ffmpeg: str, video: str):
    """Get (width, height, fps) by parsing `ffmpeg -i` stderr — works with the static ffmpeg that
    ships NO ffprobe. Fail-closed: a stream line we can't parse raises (never guess geometry)."""
    p = subprocess.run([ffmpeg, "-hide_banner", "-i", video],
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    err = p.stderr.decode("utf-8", "replace")
    mwh = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", err)
    if not mwh:
        raise RuntimeError(f"could not parse WxH from ffmpeg -i:\n{err[-800:]}")
    w, h = int(mwh.group(1)), int(mwh.group(2))
    mfps = re.search(r"(\d+(?:\.\d+)?)\s*fps", err)
    fps = float(mfps.group(1)) if mfps else 30.0
    return w, h, fps


def _iter_frames(ffmpeg: str, video: str, w: int, h: int):
    """Yield (i, HxWx3 uint8 RGB) by piping the mounted ffmpeg as raw rgb24. No cv2."""
    frame_bytes = w * h * 3
    proc = subprocess.Popen(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", video,
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=frame_bytes * 2)
    i = 0
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            yield i, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            i += 1
    finally:
        proc.stdout.close()
        rc = proc.wait()
        err = proc.stderr.read().decode("utf-8", "replace")
        proc.stderr.close()
        # Fail-closed: if ffmpeg errored AND we got no frames, the decode is a hard failure (don't
        # silently emit an empty pose — that would let a broken upload look like "no person found").
        if rc not in (0, None) and i == 0:
            raise RuntimeError(f"ffmpeg decode failed (rc={rc}):\n{err[-800:]}")


def _iou(a, b):
    """IoU of two xyxy boxes."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    aa = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    bb = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    return inter / (aa + bb - inter + 1e-9)


class _Tracker:
    """Minimal greedy-IoU multi-object tracker → stable track_id across frames (ByteTrack stand-in
    for the no-torch path). Deterministic: highest-IoU pairs matched first; unmatched detection →
    new track; a track unseen for `max_miss` frames is retired. Sufficient because downstream picks
    the dominant track (iter71 main_track) and the corpus is 1–2 athletes."""
    def __init__(self, iou_thr=0.3, max_miss=30):
        self.iou_thr = iou_thr; self.max_miss = max_miss
        self.tracks = {}            # id -> {"box": xyxy, "miss": int}
        self._next = 0

    def update(self, boxes):
        """boxes: list[xyxy] for this frame (detection order = conf desc). Returns list[track_id]
        aligned to `boxes`."""
        assigned = [None] * len(boxes)
        # candidate (iou, det_idx, track_id) pairs above threshold, matched greedily by descending IoU
        cands = []
        for di, bx in enumerate(boxes):
            for tid, tr in self.tracks.items():
                v = _iou(bx, tr["box"])
                if v >= self.iou_thr:
                    cands.append((v, di, tid))
        cands.sort(reverse=True)
        used_det, used_trk = set(), set()
        for v, di, tid in cands:
            if di in used_det or tid in used_trk:
                continue
            assigned[di] = tid; used_det.add(di); used_trk.add(tid)
            self.tracks[tid]["box"] = boxes[di]; self.tracks[tid]["miss"] = 0
        for di, bx in enumerate(boxes):
            if assigned[di] is None:
                tid = self._next; self._next += 1
                self.tracks[tid] = {"box": bx, "miss": 0}
                assigned[di] = tid
        # age + retire tracks not updated this frame
        for tid in list(self.tracks):
            if tid not in used_trk:
                self.tracks[tid]["miss"] += 1
                if self.tracks[tid]["miss"] > self.max_miss:
                    del self.tracks[tid]
        return assigned


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--checkpoint", default=DEFAULT_ONNX_CHECKPOINT)
    ap.add_argument("--ffmpeg", default="ffmpeg")          # on Fly: the mounted static binary's path
    ap.add_argument("--conf", type=float, default=0.25)    # ultralytics YOLO.predict defaults
    ap.add_argument("--iou", type=float, default=0.7)
    ap.add_argument("--max-frames", type=int, default=0)
    ap.add_argument("--no-cache", action="store_true")
    a = ap.parse_args()

    import onnxruntime as ort
    engine = {"name": "yolo11-pose-onnx", "checkpoint": a.checkpoint,
              "version": f"onnxruntime-{ort.__version__}"}

    fp = fingerprint(a.video)
    content_md5 = full_content_md5(a.video)

    # cache: reuse ONLY a pose of the SAME video CONTENT by the SAME checkpoint (iter117 discipline)
    if not a.no_cache and os.path.exists(a.out):
        try:
            prev = json.loads(Path(a.out).read_text())
            if _cache_valid(prev, content_md5, a.checkpoint):
                log(f"cache hit -> {a.out} ({sum(len(p['frames']) for p in prev.get('persons',[]))} person-frames)")
                return 0
        except Exception:
            pass

    w, h, fps = _probe_video(a.ffmpeg, a.video)
    log(f"video {w}x{h} @ {fps:.3f}fps; engine=onnx checkpoint={os.path.basename(a.checkpoint)}")

    sess = ort.InferenceSession(a.checkpoint, providers=["CPUExecutionProvider"])
    tracker = _Tracker()
    persons: dict[int, dict] = {}
    t0 = time.time(); nframes = 0
    for i, frame in _iter_frames(a.ffmpeg, a.video, w, h):
        dets = pose_onnx.infer(frame, sess, conf_thr=a.conf, iou_thr=a.iou)  # conf-desc order
        ids = tracker.update([d["box"] for d in dets])
        t = i / fps
        for d, tid in zip(dets, ids):
            kp = d["keypoints"]  # [17,3] (x,y,vis) original px
            row = [[round(float(kp[k][0]), 2), round(float(kp[k][1]), 2), round(float(kp[k][2]), 3)]
                   for k in range(17)]
            persons.setdefault(int(tid), {"track_id": int(tid), "frames": []})
            persons[int(tid)]["frames"].append({"t": round(t, 4), "i": i, "kp": row})
        nframes = i + 1
        if a.max_frames and nframes >= a.max_frames:
            break
        if i and i % 60 == 0:
            log(f"  {i} frames, {len(persons)} persons, {nframes/(time.time()-t0):.1f} fps")

    out = {
        "schema": "pose.keypoints.v1",
        "engine": engine,
        "video": {"path": os.path.abspath(a.video), "fps": round(fps, 4),
                  "width": w, "height": h, "frames": nframes,
                  "source_fingerprint": fp, "content_md5": content_md5},
        "keypoint_names": COCO17,
        "persons": [persons[k] for k in sorted(persons)],
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(canonicalize_pose_track(out), separators=(",", ":")))
    log(f"wrote {a.out}: {len(out['persons'])} persons, {nframes} frames, {time.time()-t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
