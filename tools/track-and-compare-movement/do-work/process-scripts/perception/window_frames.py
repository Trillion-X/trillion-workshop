"""Frames of a clip at given frame numbers, read so memory stays bounded by the window, not by the clip.

WHY: heading_for_window and elevation_for_window each opened `cv2.VideoCapture`, seeked with `cap.set(POS_FRAMES)` and
read about 8 to 16 frames for EVERY window. Each seek-and-read keeps about half a megabyte of 1080p decoder memory that
`cap.release()` never returns (measured Nov 25 2026: 300 seek-reads grew the process 57 -> 708 MB, one read per
capture; model runs on the frames stayed flat). A long clip has thousands of windows, so the process grew without
bound (an 11-minute 1080p clip reached 85 GB). Here one short-lived ffmpeg process decodes a window's frames and exits,
so the operating system takes every byte back. The frame numbering and the picture are the same as cv2's: frame
`fi` is the frame at `fi / fps` (pixel-equal to cv2's seek-and-read, checked in test_window_frames.py).

clip_props(video) -> (fps, total_frames): cv2's own header read, cached per clip. Opening a capture only to read
properties does not grow (measured), and caching reads it once per clip rather than once per window.
"""
from __future__ import annotations
import json
import subprocess
from functools import lru_cache

import numpy as np


@lru_cache(maxsize=8)
def clip_props(video: str) -> tuple[float, int]:
    import cv2
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    tot = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    cap.release()
    return fps, tot


@lru_cache(maxsize=8)
def _shape(video: str) -> tuple[int, int]:
    """(width, height) of the frames ffmpeg hands over: the stored size, turned when the clip carries a 90/270 rotation."""
    ran = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height:stream_side_data=rotation", "-of", "json", video],
                         capture_output=True, text=True, check=True)
    stream = json.loads(ran.stdout)["streams"][0]
    width, height = int(stream["width"]), int(stream["height"])
    turns = [abs(int(float(side.get("rotation", 0)))) % 180 for side in stream.get("side_data_list", [])]
    return (height, width) if any(turn == 90 for turn in turns) else (width, height)


def read_frames(video, frame_numbers) -> list:
    """The BGR frame (H, W, 3 uint8) for each frame number, in the order asked; None where the clip has no such frame."""
    video = str(video)
    fps, _ = clip_props(video)
    width, height = _shape(video)
    wanted = sorted({int(n) for n in frame_numbers})
    first = wanted[0]
    # Start half a frame early so the first decoded frame is exactly `first`; the filter then counts from it.
    start = max(0.0, (first - 0.5) / fps)
    pick = "+".join(f"eq(n\\,{n - first})" for n in wanted)
    size = width * height * 3
    # One buffer of exactly the size asked for, filled straight from the pipe (no growing list of chunks to join).
    buffer = np.empty(len(wanted) * size, np.uint8)
    with subprocess.Popen(["ffmpeg", "-v", "error", "-ss", f"{start:.6f}", "-i", video, "-vf", f"select={pick}", "-vsync", "0",
                           "-frames:v", str(len(wanted)), "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as ffmpeg:
        filled = 0
        view = memoryview(buffer)
        while filled < len(buffer):
            count = ffmpeg.stdout.readinto(view[filled:])
            if not count:
                break
            filled += count
        view.release()
    got = {n: buffer[i * size:(i + 1) * size].reshape(height, width, 3)
           for i, n in enumerate(wanted) if (i + 1) * size <= filled}
    return [got.get(int(n)) for n in frame_numbers]
