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

HERE = Path(__file__).resolve().parent
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


def synced_side(sides: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The phase sync (phase_sync.v1) of the one side that names `sync`, checked against both peaks; None when no
    side is synced. The synced side is the sync's reference; the other side is its target and plays as recorded."""
    named = [side for side in sides if side.get("sync")]
    if not named:
        return None
    if len(named) > 1:
        raise ValueError("only one side can be retimed by a sync; the other plays as recorded")
    retimed = named[0]
    sync = retimed["sync"] if isinstance(retimed["sync"], dict) else read_json(retimed["sync"])
    if sync.get("kind") != "phase_sync.v1":
        raise ValueError(f"sync must be a phase_sync.v1 made by phase_sync.py, not {sync.get('kind')!r}")
    other = sides[1 - sides.index(retimed)]
    for side, part in ((retimed, "reference"), (other, "target")):
        if abs(float(side["peak"]) - sync[part]["contact"]) > 1e-3:
            raise ValueError(f"the {part} peak {side['peak']} is not the sync's {part} contact {sync[part]['contact']}; make the sync for these peaks")
    return sync


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
    sync = synced_side(sides)
    if sync:
        sys.path.insert(0, str(HERE))
        from phase_sync import reference_window  # the sync's owner does its window arithmetic (numpy only when synced)
    segments = []
    for one_pass in spec["passes"]:
        target = float(one_pass.get("half", 1.0))
        # One symmetric half clamped to BOTH clips keeps the two cells phase-aligned and in bounds.
        half = min(safe_half(target, float(side["peak"]), durations[side["clip"]]) if durations.get(side["clip"]) else target for side in sides)
        if sync:
            window = sync["target"]
            half = min(half, window["contact"] - window["in"], window["out"] - window["contact"])
        suffix = one_pass.get("label_suffix", "")
        still = one_pass.get("still")
        sources = []
        for side in sides:
            peak = float(side["peak"])
            seconds: dict[str, Any] = {"in": round(peak - half, 3), "out": round(peak + half, 3)}
            centre, reach = peak, half
            if side.get("sync") and not still:
                seconds = reference_window(sync, sync["target"]["contact"] - half, sync["target"]["contact"] + half)
                centre, reach = (seconds["in"] + seconds["out"]) / 2, (seconds["out"] - seconds["in"]) / 2
            if still:
                seconds = {"in": round(peak, 3)}
            crop = player_crop(side["kp"], centre, max(reach, 0.6), aspect, side.get("track_id"), spec.get("crop"))
            source: dict[str, Any] = {
                "source": side["clip"],
                **{key: seconds[key] for key in ("in", "out") if key in seconds},
                "crop": crop,
                "label": {"text": str(side.get("label", "")) + suffix, "corner": side.get("corner", "tl"), "size": int(side.get("label_size", 54))},
            }
            if side.get("flip"):
                source["flip"] = side["flip"]
            if "speed_ramp" in seconds:
                source["speed_ramp"] = seconds["speed_ramp"]
            sources.append(source)
        segment: dict[str, Any] = {"id": one_pass["id"], "kind": "split", "layout": layout, "sources": sources}
        if still:
            segment["still"] = {"duration": float(still)}
        if one_pass.get("speed") and not still:
            segment["speed"] = float(one_pass["speed"])
        if one_pass.get("smooth") and not still:
            if not 0 < float(one_pass.get("speed") or 1) < 1:
                raise ValueError(f"pass {one_pass['id']!r} asks for smooth motion, which makes in-between frames for a slowed pass only (speed below 1)")
            segment["speed_smooth"] = True
        segments.append(segment)
    edl: dict[str, Any] = {
        "encode": {"width": width, "height": height, "fps": encode.get("fps", 30), "crf": encode.get("crf", 20), "preset": encode.get("preset", "medium")},
        "base": {"kind": "color", "color": spec.get("bg", "black")},
        "spine": {"segments": segments},
    }
    if spec.get("voice_audio"):
        edl["audio_graph"] = {"replace_audio": spec["voice_audio"]}
    return edl


def variant_specs(spec: dict[str, Any], variants: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """One spec per format of `variants` (comparison-variants.json): the format's picture size and layout, and the
    variants' passes unless the spec names its own. Keyed by the format id."""
    made = {}
    for one_format in variants["formats"]:
        encode = {**spec.get("encode", {}), "width": int(one_format["width"]), "height": int(one_format["height"])}
        made[one_format["id"]] = {**spec, "encode": encode, "layout": one_format["layout"], "passes": spec.get("passes") or variants["passes"]}
    return made


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
    parser.add_argument("--variants", help="a comparison-variants.json: write one edit per format, OUT with .FORMAT before .json")
    args = parser.parse_args()
    try:
        spec = read_json(args.spec)
        durations = {side["clip"]: probe_duration(side["clip"]) for side in (spec["left"], spec["right"])}
        known = {clip: seconds for clip, seconds in durations.items() if seconds is not None}
        if args.variants:
            out = Path(args.out)
            edls = {str(out.with_name(f"{out.stem}.{name}{out.suffix}")): build_edl(one, known) for name, one in variant_specs(spec, read_json(args.variants)).items()}
        else:
            edls = {args.out: build_edl(spec, known)}
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}; check the spec against the shape in the file's header"}))
        return 2
    for path, edl in edls.items():
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(edl, handle, indent=2)
    if args.variants:
        print(json.dumps({"result": {"outs": list(edls), "segments": [len(edl["spine"]["segments"]) for edl in edls.values()]}}))
    else:
        print(json.dumps({"result": {"out": args.out, "segments": len(edls[args.out]["spine"]["segments"])}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
