#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/reel/render_side_by_side.py
#
# PURPOSE: Reel-factory stage [4] `render.skeleton_overlay` — composite two clips (student left,
# reference right) into ONE phase-aligned side-by-side video with COCO-17 skeleton overlays drawn
# on each. The phase alignment (which student frame pairs with which reference frame) comes from the
# `phase_alignment.v1` fact produced by stage [3] align.dtw; this stage is a DETERMINISTIC RENDERER
# (opencv compositing), not a learned model.
#
# GENERIC: knows nothing about tennis. Given any two clips + their pose tracks + a DTW alignment it
# emits the side-by-side. Deletion test PASSES (any sport / any two movements).
#
# FAIL-CLOSED: missing input, unreadable video, or empty alignment -> non-zero exit + reason.
#
# USAGE: render_side_by_side.py --student-clip S.mp4 --reference-clip R.mp4 \
#           --student-kp S.kp.json --reference-kp R.kp.json --alignment ALIGN.json --out SXS.mp4
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
import numpy as np
import cv2

EDGES = [(5, 7), (7, 9), (6, 8), (8, 10), (5, 6), (5, 11), (6, 12), (11, 12),
         (11, 13), (13, 15), (12, 14), (14, 16), (0, 5), (0, 6)]
PANEL_W, PANEL_H = 540, 960  # each panel 9:16 half; final 1080x960 -> crop stage makes 1080x1920


def log(m): print(f"[render.sxs] {m}", file=sys.stderr, flush=True)


def _primary_frames(track: dict) -> list:
    persons = track.get("persons", [])
    if not persons:
        return []
    def sc(p):
        return sum(pt[2] for fr in p.get("frames", []) for pt in ((fr.get("kp") or fr.get("keypoints") or fr) if isinstance(fr, dict) else fr) if len(pt) >= 3)
    return max(persons, key=sc).get("frames", [])


def _read_frames(path: str, want: int) -> list:
    cap = cv2.VideoCapture(path)
    frames = []
    while len(frames) < want:
        ok, fr = cap.read()
        if not ok:
            break
        frames.append(fr)
    cap.release()
    return frames


def _draw(img, kp, sx, sy):
    for pt in kp:
        if len(pt) >= 3 and pt[2] > 0.2:
            cv2.circle(img, (int(pt[0] * sx), int(pt[1] * sy)), 4, (0, 255, 90), -1)
    for a, b in EDGES:
        if a < len(kp) and b < len(kp) and kp[a][2] > 0.2 and kp[b][2] > 0.2:
            cv2.line(img, (int(kp[a][0] * sx), int(kp[a][1] * sy)),
                     (int(kp[b][0] * sx), int(kp[b][1] * sy)), (0, 200, 255), 2)


def _panel(video_frames, kp_frames, idx, label):
    canvas = np.zeros((PANEL_H, PANEL_W, 3), dtype=np.uint8)
    if 0 <= idx < len(video_frames):
        raw = video_frames[idx]
        h, w = raw.shape[:2]
        scale = min(PANEL_W / w, PANEL_H / h)
        nw, nh = int(w * scale), int(h * scale)
        resized = cv2.resize(raw, (nw, nh))
        ox, oy = (PANEL_W - nw) // 2, (PANEL_H - nh) // 2
        canvas[oy:oy + nh, ox:ox + nw] = resized
        if idx < len(kp_frames):
            kp = (kp_frames[idx].get("kp") or kp_frames[idx].get("keypoints") or kp_frames[idx]) if isinstance(kp_frames[idx], dict) else kp_frames[idx]
            _draw(canvas[oy:oy + nh, ox:ox + nw], kp, scale, scale)
    cv2.rectangle(canvas, (0, 0), (PANEL_W, 54), (0, 0, 0), -1)
    cv2.putText(canvas, label, (18, 37), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA)
    return canvas


def main() -> int:
    ap = argparse.ArgumentParser(description="Reel stage render.skeleton_overlay: phase-aligned side-by-side.")
    ap.add_argument("--student-clip", required=True); ap.add_argument("--reference-clip", required=True)
    ap.add_argument("--student-kp", required=True); ap.add_argument("--reference-kp", required=True)
    ap.add_argument("--alignment", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--student-label", default="YOU"); ap.add_argument("--reference-label", default="REFERENCE")
    a = ap.parse_args()
    try:
        align = json.load(open(a.alignment)); path = align.get("path", [])
        skp = _primary_frames(json.load(open(a.student_kp)))
        rkp = _primary_frames(json.load(open(a.reference_kp)))
    except Exception as e:
        log(f"REFUSED: cannot read inputs: {e}"); return 2
    if not path:
        log("REFUSED: empty alignment path"); return 1
    sv = _read_frames(a.student_clip, len(skp) + 2)
    rv = _read_frames(a.reference_clip, len(rkp) + 2)
    if not sv or not rv:
        log(f"REFUSED: unreadable video student={len(sv)} ref={len(rv)}"); return 1
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    tmp = str(Path(a.out).with_suffix(".raw.mp4"))
    vw = cv2.VideoWriter(tmp, cv2.VideoWriter_fourcc(*"mp4v"), a.fps, (PANEL_W * 2, PANEL_H))
    for si, ri in path:
        left = _panel(sv, skp, si, a.student_label)
        right = _panel(rv, rkp, ri, a.reference_label)
        vw.write(np.hstack([left, right]))
    vw.release()
    # re-encode to h264 for universal playback (mp4v -> libx264)
    import subprocess
    r = subprocess.run(["ffmpeg", "-y", "-i", tmp, "-c:v", "libx264", "-pix_fmt", "yuv420p", a.out],
                       capture_output=True, text=True)
    Path(tmp).unlink(missing_ok=True)
    if r.returncode != 0 or not Path(a.out).exists():
        log(f"REFUSED: ffmpeg encode failed: {r.stderr[-200:]}"); return 1
    log(f"side-by-side ({len(path)} phase-aligned frames) -> {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
