#!/usr/bin/env python3
"""Find the people in a video and where their joints are, frame by frame, as a `pose.keypoints.v1` track.

PURPOSE: the one script that knows a pose engine (ultralytics YOLO pose). Everything that reads a track (see
align_dtw.py) reads the contract in read-data/pose_schema.py and never the engine, so another engine is another
producer with the same output.

INVARIANTS
  - Output is COCO-17 keypoints, [x, y, confidence] per joint, in pixels, per person (`persons[]`, each with a
    track_id that stays the same across frames) per frame (`t` seconds, `i` frame number).
  - A track already written for the same video bytes and the same checkpoint is reused, never recomputed: pose
    is expensive. The video's identity is a digest of every byte.
  - The checkpoint is the caller's: this script names no model and downloads none.
  - One job only: no angles, no rendering.

USAGE: estimate_pose.py --video IN.mp4 --out TRACK.json --checkpoint POSE_WEIGHTS.pt [--device cpu|mps|cuda]
                        [--conf 0.3] [--max-frames N] [--no-cache]
The last line printed is {"result": {...}} or {"error": "what to change"}.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "read-data"))
from pose_schema import COCO, canonicalize_pose_track  # noqa: E402


def log(message):
    print(f"[pose] {message}", file=sys.stderr, flush=True)


def refuse(message, code=2):
    print(json.dumps({"error": message}))
    return code


def content_digest(path):
    """A digest of every byte of the file: two videos share one only when they are the same bytes."""
    digest = hashlib.blake2b(digest_size=32)
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return "blake2b:" + digest.hexdigest()


def cache_valid(previous, digest, checkpoint):
    """A written track is reusable only if it was made from the same video bytes by the same checkpoint."""
    video = previous.get("video", {})
    return isinstance(video, dict) and bool(digest) and video.get("content_digest") == digest \
        and previous.get("engine", {}).get("checkpoint") == checkpoint


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--device", default=None)
    parser.add_argument("--conf", type=float, default=0.3)
    parser.add_argument("--max-frames", type=int, default=0)
    parser.add_argument("--no-cache", action="store_true")
    args = parser.parse_args()

    if not Path(args.video).is_file():
        return refuse(f"the video is not a file on this computer: {args.video}")
    if not Path(args.checkpoint).is_file():
        return refuse(f"the pose checkpoint is not a file on this computer: {args.checkpoint}; give the path of a downloaded pose model")
    digest = content_digest(args.video)

    if Path(args.out).exists() and not args.no_cache:
        try:
            previous = canonicalize_pose_track(json.loads(Path(args.out).read_text()))
            if cache_valid(previous, digest, args.checkpoint):
                frames = sum(len(person["frames"]) for person in previous.get("persons", []))
                log(f"cache hit -> {args.out} ({frames} person-frames)")
                print(json.dumps({"result": {"out": args.out, "persons": len(previous.get("persons", [])), "frames": previous["video"]["frames"], "cached": True}}))
                return 0
        except (ValueError, KeyError, OSError):
            pass

    try:
        import cv2
        import ultralytics
        from ultralytics import YOLO
    except ImportError as error:
        return refuse(f"a package is missing: {error}; install opencv-python and ultralytics")
    engine = {"name": "ultralytics-pose", "checkpoint": args.checkpoint, "version": f"ultralytics-{ultralytics.__version__}"}

    capture = cv2.VideoCapture(args.video)
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    capture.release()
    log(f"video {width}x{height} @ {fps:.3f}fps; checkpoint={args.checkpoint} device={args.device or 'auto'}")

    model = YOLO(args.checkpoint)
    persons: dict[int, dict] = {}
    started = time.time()
    seen = 0
    options = {"source": args.video, "stream": True, "conf": args.conf, "verbose": False, "persist": True}
    if args.device:
        options["device"] = args.device
    # model.track keeps one id per person across frames, which a clip with several people needs.
    for result in model.track(**options):
        t = seen / fps
        points = result.keypoints
        if points is not None and points.xy is not None and len(points.xy):
            ids = result.boxes.id.int().cpu().tolist() if (result.boxes is not None and result.boxes.id is not None) else list(range(len(points.xy)))
            xy = points.xy.cpu().numpy()
            confidence = points.conf.cpu().numpy() if points.conf is not None else None
            for index, track_id in enumerate(ids):
                row = [[round(float(xy[index][k][0]), 2), round(float(xy[index][k][1]), 2),
                        round(float(confidence[index][k]), 3) if confidence is not None else 1.0] for k in range(len(COCO))]
                persons.setdefault(int(track_id), {"track_id": int(track_id), "frames": []})
                persons[int(track_id)]["frames"].append({"t": round(t, 4), "i": seen, "kp": row})
        seen += 1
        if args.max_frames and seen >= args.max_frames:
            break
        if seen % 60 == 0:
            log(f"  {seen} frames, {len(persons)} persons, {seen / (time.time() - started):.1f} fps")

    track = {
        "schema": "pose.keypoints.v1",
        "engine": engine,
        "video": {"path": os.path.abspath(args.video), "fps": round(fps, 4), "width": width, "height": height, "frames": seen, "content_digest": digest},
        "keypoint_names": COCO,
        "persons": [persons[key] for key in sorted(persons)],
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(canonicalize_pose_track(track), separators=(",", ":")))
    log(f"wrote {args.out}: {len(track['persons'])} persons, {seen} frames, {time.time() - started:.1f}s")
    print(json.dumps({"result": {"out": args.out, "persons": len(track["persons"]), "frames": seen, "cached": False}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
