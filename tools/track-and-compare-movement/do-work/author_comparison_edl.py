#!/usr/bin/env python3
"""Turn two pose-tracked clips and the moment to centre on in each into a media-composition side-by-side edit.

PURPOSE: the producer half of a movement comparison. It reads each clip's pose track (see estimate_pose.py) and
writes the crop rectangles as DATA in an edit for the media-composition tool, so the compositor never sees a
keypoint. It only WRITES the edit JSON; it renders nothing and imports nothing from media-composition.

Everything is DATA: labels, layout, flip, the passes (a full pass, a slow-motion pass) and the encode settings are
the spec. No name, no movement and no count is in this file.

USAGE: author_comparison_edl.py --spec SPEC.json --out EDIT.json
SPEC.json:
{
  "encode": {"width": 1920, "height": 1080, "fps": 30, "crf": 20, "preset": "medium"},
  "layout": "h",                              h = side by side, v = stacked
  "bg": "black",
  "left":  {"clip": "a.mp4", "kp": "a.pose.json", "peak": 4.8, "label": "A", "corner": "tl", "track_id": 1},
  "right": {"clip": "b.mp4", "kp": "b.pose.json", "peak": 16.85, "label": "B", "corner": "tr", "flip": "h"},
  "passes": [ {"id": "full", "half": 1.0}, {"id": "slow", "half": 0.5, "speed": 0.4, "label_suffix": " (slow)"} ],
  "crop": {"min_confidence": 0.3, "pad_height": 1.6, "pad_width": 1.35},          optional
  "voice_audio": "narration.wav"                                                  optional: replaces the audio
}
`peak` is the second of each clip that the pass is centred on; `half` is how many seconds each way. `track_id`
picks the person to frame (the first person when absent). The last line printed is {"result": ...} or {"error": ...}.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

CROP_DEFAULTS = {"min_confidence": 0.3, "pad_height": 1.6, "pad_width": 1.35}


def read_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def person_frames(track: dict[str, Any], track_id: int | None) -> list[dict[str, Any]]:
    persons = track.get("persons") or []
    if track_id is None:
        return persons[0].get("frames", []) if persons else []
    for person in persons:
        if person.get("track_id") == track_id:
            return person.get("frames", [])
    raise ValueError(f"the pose track has no person with track_id {track_id}")


def player_crop(kp_path: str, peak_t: float, half: float, cell_aspect: float, track_id: int | None = None, crop: dict[str, float] | None = None) -> dict[str, int]:
    """The union of confident joints in [peak - half, peak + half], padded and cut to the cell's aspect, CLAMPED to
    the source frame (a crop larger than the frame is an error in ffmpeg, and the compositor knows no source size).
    With no confident joint: a centred full-height crop at the cell aspect, never a crash."""
    settings = {**CROP_DEFAULTS, **(crop or {})}
    track = read_json(kp_path)
    width, height = track["video"]["width"], track["video"]["height"]
    xs: list[float] = []
    ys: list[float] = []
    for frame in person_frames(track, track_id):
        if abs(frame["t"] - peak_t) > half:
            continue
        for x, y, confidence in (point[:3] for point in frame["kp"]):
            if confidence > settings["min_confidence"]:
                xs.append(x)
                ys.append(y)
    if not xs:
        cell_width = min(width, int(height * cell_aspect))
        return {"w": cell_width, "h": height, "x": (width - cell_width) // 2, "y": 0}
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    centre_x, centre_y = (x0 + x1) / 2, (y0 + y1) / 2
    box_height = max((y1 - y0) * settings["pad_height"], (x1 - x0) * settings["pad_width"])
    out_height = min(height, box_height)
    out_width = out_height * cell_aspect
    if out_width > width:
        out_width = width
        out_height = out_width / cell_aspect
    x = max(0.0, min(centre_x - out_width / 2, width - out_width))
    y = max(0.0, min(centre_y - out_height / 2, height - out_height))
    return {"w": int(out_width), "h": int(out_height), "x": int(x), "y": int(y)}


def safe_half(target: float, peak: float, clip_duration: float) -> float:
    """The largest symmetric half-window that keeps both seek bounds inside the clip."""
    return max(0.2, min(target, peak - 0.05, clip_duration - peak - 0.05))


def cell_aspect(layout: str, width: int, height: int) -> float:
    """Two equal cells: side by side (h) splits the width; stacked (v) splits the height."""
    return (width / 2) / height if layout == "h" else width / (height / 2)


def build_edl(spec: dict[str, Any], clip_durations: dict[str, float] | None = None) -> dict[str, Any]:
    encode = spec.get("encode", {})
    width = encode.get("width", 1920)
    height = encode.get("height", 1080)
    layout = spec.get("layout", "h")
    if layout not in ("h", "v"):
        raise ValueError(f"layout must be 'h' (side by side) or 'v' (stacked), not {layout!r}")
    aspect = cell_aspect(layout, width, height)
    sides = [spec["left"], spec["right"]]
    durations = clip_durations or {}
    segments = []
    for one_pass in spec["passes"]:
        target = float(one_pass.get("half", 1.0))
        # One symmetric half clamped to BOTH clips keeps the two cells phase-aligned and in bounds.
        half = min(safe_half(target, float(side["peak"]), durations[side["clip"]]) if durations.get(side["clip"]) else target for side in sides)
        suffix = one_pass.get("label_suffix", "")
        sources = []
        for side in sides:
            crop = player_crop(side["kp"], float(side["peak"]), max(half, 0.6), aspect, side.get("track_id"), spec.get("crop"))
            source: dict[str, Any] = {
                "source": side["clip"],
                "in": round(float(side["peak"]) - half, 3),
                "out": round(float(side["peak"]) + half, 3),
                "crop": crop,
                "label": {"text": str(side.get("label", "")) + suffix, "corner": side.get("corner", "tl"), "size": int(side.get("label_size", 54))},
            }
            if side.get("flip"):
                source["flip"] = side["flip"]
            sources.append(source)
        segment: dict[str, Any] = {"id": one_pass["id"], "kind": "split", "layout": layout, "sources": sources}
        if one_pass.get("speed"):
            segment["speed"] = float(one_pass["speed"])
        segments.append(segment)
    edl: dict[str, Any] = {
        "encode": {"width": width, "height": height, "fps": encode.get("fps", 30), "crf": encode.get("crf", 20), "preset": encode.get("preset", "medium")},
        "base": {"kind": "color", "color": spec.get("bg", "black")},
        "spine": {"segments": segments},
    }
    if spec.get("voice_audio"):
        edl["audio_graph"] = {"replace_audio": spec["voice_audio"]}
    return edl


def probe_duration(path: str) -> float | None:
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True, timeout=30).stdout.strip()
        return float(out) if out else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description="two pose-tracked clips -> a media-composition side-by-side edit")
    parser.add_argument("--spec", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    try:
        spec = read_json(args.spec)
        durations = {side["clip"]: probe_duration(side["clip"]) for side in (spec["left"], spec["right"])}
        edl = build_edl(spec, {clip: seconds for clip, seconds in durations.items() if seconds is not None})
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}; check the spec against the shape in the file's header"}))
        return 2
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(edl, handle, indent=2)
    print(json.dumps({"result": {"out": args.out, "segments": len(edl["spine"]["segments"])}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
