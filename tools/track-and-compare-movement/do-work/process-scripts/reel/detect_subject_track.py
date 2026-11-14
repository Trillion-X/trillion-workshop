#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/reel/detect_subject_track.py
#
# PURPOSE: perception stage `vision.subject.track`. Emits `subject_track.v1`, a normalized 0..1
# subject-center path {track:[{t,cx,cy}]} sampled over a clip. This is the DATA that drives
# media-composition's `reframe` auto-crop (16:9 to 9:16 that FOLLOWS the subject instead of the
# naive scale+letterbox in render_vertical_crop.py). The detector lives HERE (perception owner),
# never inside the compositor: motion-analysis DETECTS, media-composition CROPS/RENDERS, and the
# emitted track is the only coupling (Envelope DATA), so either side changes with zero edits to
# the other.
#
# ENSEMBLE (each a fallback of the prior, most-specific first): (1) largest haar face; (2) DNN
# person box if a caffe/onnx model is provided by env (MODEL IS DATA, L090); (3) frame-difference
# motion centroid; (4) static center 0.5. A per-sample confidence records which tier fired. The
# path is EMA-smoothed (SP-provenance) so the downstream crop never jitters.
#
# FAIL-SOFT (not fail-closed): a clip with no detectable subject is a valid case, so it yields a
# center track with confidence 0.0, never a crash and never a fabricated position.
#
# USAGE: detect_subject_track.py --clip CLIP.mp4 --out TRACK.json [--fps 4] [--smooth 0.35]
from __future__ import annotations
import argparse, json, os, sys
from pathlib import Path


def log(m): print(f"[vision.subject.track] {m}", file=sys.stderr, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="perception vision.subject.track: normalized subject-center path.")
    ap.add_argument("--clip", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=float, default=4.0, help="samples per second (the track is interpolated at render)")
    ap.add_argument("--smooth", type=float, default=0.35, help="EMA factor 0..1 (higher = snappier, lower = smoother)")
    a = ap.parse_args()
    if not Path(a.clip).exists():
        log(f"REFUSED: clip missing: {a.clip}")
        return 2
    try:
        import cv2
        import numpy as np
    except Exception as e:
        log(f"REFUSED: opencv/numpy unavailable: {e}")
        return 3

    cap = cv2.VideoCapture(a.clip)
    if not cap.isOpened():
        log(f"REFUSED: cannot open {a.clip}")
        return 1
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(src_fps / max(0.5, a.fps))))

    face_xml = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    face_cascade = cv2.CascadeClassifier(face_xml) if os.path.exists(face_xml) else None
    # optional DNN person detector (MODEL IS DATA): SUBJECT_DNN_PROTO + SUBJECT_DNN_MODEL
    proto, model = os.environ.get("SUBJECT_DNN_PROTO"), os.environ.get("SUBJECT_DNN_MODEL")
    net = None
    if proto and model and Path(proto).exists() and Path(model).exists():
        try:
            net = cv2.dnn.readNetFromCaffe(proto, model)
        except Exception as e:
            log(f"DNN model present but failed to load ({e}); continuing without it")

    def detect(frame_gray, frame_bgr, prev_gray):
        h, w = frame_gray.shape[:2]
        # (1) face
        if face_cascade is not None:
            faces = face_cascade.detectMultiScale(frame_gray, scaleFactor=1.15, minNeighbors=5, minSize=(48, 48))
            if len(faces):
                fx, fy, fw, fh = max(faces, key=lambda r: r[2] * r[3])
                return (fx + fw / 2) / w, (fy + fh / 2) / h, 1.0
        # (2) DNN person
        if net is not None:
            blob = cv2.dnn.blobFromImage(cv2.resize(frame_bgr, (300, 300)), 0.007843, (300, 300), 127.5)
            net.setInput(blob)
            det = net.forward()
            best, ba = None, 0.0
            for i in range(det.shape[2]):
                conf = float(det[0, 0, i, 2])
                if conf > 0.4:
                    x1, y1, x2, y2 = det[0, 0, i, 3:7]
                    area = max(0.0, (x2 - x1)) * max(0.0, (y2 - y1))
                    if area > ba:
                        ba, best = area, ((x1 + x2) / 2, (y1 + y2) / 2)
            if best is not None:
                return float(best[0]), float(best[1]), 0.8
        # (3) motion centroid
        if prev_gray is not None:
            diff = cv2.absdiff(frame_gray, prev_gray)
            _, thr = cv2.threshold(diff, 18, 255, cv2.THRESH_BINARY)
            m = cv2.moments(thr, binaryImage=True)
            if m["m00"] > 500:
                return (m["m10"] / m["m00"]) / w, (m["m01"] / m["m00"]) / h, 0.5
        # (4) center
        return 0.5, 0.5, 0.0

    track, prev_gray, ema_cx, ema_cy = [], None, None, None
    idx = 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if idx % step == 0:
            ok, frame = cap.retrieve()
            if ok:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                cx, cy, conf = detect(gray, frame, prev_gray)
                ema_cx = cx if ema_cx is None else (a.smooth * cx + (1 - a.smooth) * ema_cx)
                ema_cy = cy if ema_cy is None else (a.smooth * cy + (1 - a.smooth) * ema_cy)
                t = idx / src_fps
                track.append({"t": round(t, 3), "cx": round(float(ema_cx), 4),
                              "cy": round(float(ema_cy), 4), "confidence": round(float(conf), 2)})
                prev_gray = gray
        idx += 1
    cap.release()
    if not track:
        track = [{"t": 0.0, "cx": 0.5, "cy": 0.5, "confidence": 0.0}]
    mean_conf = sum(p["confidence"] for p in track) / len(track)
    out = {"kind": "subject_track.v1", "detector": "ensemble(face>dnn>motion>center)",
           "track": track, "provenance": {"confidence": round(mean_conf, 3), "samples": len(track),
                                          "stage": "vision.subject.track", "smooth": a.smooth}}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(a.out, "w"))
    log(f"emitted {len(track)} samples, mean_conf={mean_conf:.2f} -> {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
