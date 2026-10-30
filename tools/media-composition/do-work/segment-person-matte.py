#!/usr/bin/env python3
"""
segment-person-matte.py: turn a video into a grayscale ALPHA MATTE video (white = subject,
black = background) using rembg (U^2-Net salient-object / human segmentation, onnxruntime).

This is ONE producer of the generic matte an overlay is keyed by (via ffmpeg alphamerge in
video-compose.mjs). The compositor stays blind: it just alphamerges whatever grayscale matte
this (or any other) producer emits. AI segmentation is a DATA-selected matte source, not a
special case baked into the render (L069 / green screen without a screen).

Usage: segment-person-matte.py <input-video> <output-matte-mp4> [model]
  model: a rembg model name. Default 'u2net_human_seg' (people). 'u2netp' = small general
         salient-object model. The model downloads once on first use (onnxruntime).

Reads ONLY the explicit input path (no directory scan, no scheduling). Iterates the input's
frames once and emits a matte at the same dimensions, fps, and frame count so ffmpeg alphamerge
lines up frame-for-frame.
"""
import sys
import cv2
import numpy as np
from rembg import remove, new_session


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: segment-person-matte.py <input-video> <output-matte-mp4> [model]\n")
        return 2
    in_path, out_path = sys.argv[1], sys.argv[2]
    model = sys.argv[3] if len(sys.argv) > 3 else "u2net_human_seg"

    cap = cv2.VideoCapture(in_path)
    if not cap.isOpened():
        sys.stderr.write(f"cannot open input video: {in_path}\n")
        return 1
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    declared = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    # Bound the single read pass by the declared frame count (fallback to a safe ceiling if the
    # container does not report one). This iterates the frames once; it is not a wait/poll loop.
    limit = declared if declared > 0 else 10_000_000

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(out_path, fourcc, fps, (width, height), isColor=True)

    session = new_session(model)
    frames = 0
    try:
        for _ in range(limit):
            ok, frame = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mask = remove(rgb, only_mask=True, session=session)  # HxW uint8, 255 = subject
            if mask is None:
                mask = np.zeros((height, width), dtype=np.uint8)
            mask = np.asarray(mask)
            if mask.ndim == 3:
                mask = mask[:, :, 0]
            gray = mask.astype(np.uint8)
            if gray.shape[:2] != (height, width):
                gray = cv2.resize(gray, (width, height), interpolation=cv2.INTER_LINEAR)
            # a 3-channel gray frame: ffmpeg format=gray takes the luma as the alpha matte.
            writer.write(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR))
            frames += 1
    finally:
        cap.release()
        writer.release()

    sys.stderr.write(f"segment-person-matte: wrote {frames} matte frames ({width}x{height} @ {fps:.3f}fps, model={model}) to {out_path}\n")
    return 0 if frames > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
