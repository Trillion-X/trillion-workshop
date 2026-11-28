#!/usr/bin/env python3
"""Check that every cell of a comparison edit keeps the player's whole body and racket inside its crop, on every frame.

PURPOSE: author_comparison_edl.py cuts each cell's crop from the pose track alone, so nothing proves the racket stays
inside. This reads that edit, measures each cell's source over the cell's own time range with the existing
tools/frame-the-whole-movement-in-view `measure` (the subject box and the implement box near it, per sampled frame),
and answers per cell:
  - the frames where the subject box or the subject-plus-implement box crosses the crop edge;
  - when there are any, the smallest widened crop that has none: never smaller than the cell's crop, at the cell's
    aspect, inside the source frame, holding every measured box plus a margin, as close to the old crop's place as it
    can sit. When no crop of the cell's shape fits the source: with --when-too-wide fit-blurred (the default) the cell
    is FITTED: its crop holds every box (as near the cell's shape as the source allows) and is shown whole, scaled into
    the cell over a blurred fill of itself (the source's `fit`, which media-composition's split layout draws), so the
    movement is in view by construction; with refuse, a refusal that names why.
A fitted cell is checked like any other: its crop must hold every box (it is shown whole, so nothing in it is cut).
Frames with no detected subject are counted as `undetected_frames`, not as crossing (the same rule as the measure tool).

USAGE: whole_movement_check.py --edit EDIT.json --model SEG_MODEL.pt [--work DIR] [--write-edit FIXED.json]
         [--subject-class 0] [--implement-class 38] [--sample-fps 6] [--imgsz 960] [--conf 0.2] [--near-px 400]
         [--margin 0.03] [--when-too-wide fit-blurred|refuse]
EDIT.json is the edit author_comparison_edl.py writes: spine.segments[].sources[] each with source, in, out (source
seconds) and crop {x, y, w, h} (source pixels); the cell aspect comes from encode and the segment layout (h or v),
or from the crop itself when the edit names neither.
SEG_MODEL.pt is an ultralytics segmentation model (yolo11n-seg); the measure tool loads it and downloads nothing.
--write-edit writes a copy of the edit whose crop is the widened one wherever a cell needed it (a cell with a refusal
keeps its crop), so the corrected edit can go straight to the renderer.
The last line printed is {"result": ...} or {"error": ...}. Exit 0 when every cell passes or was widened, 1 when a cell
has a refusal, 2 on bad input.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import math
import sys
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from author_comparison_edl import cell_aspect  # noqa: E402  the one owner of the cell aspect

MEASURE_TOOL = HERE.parent.parent / "frame-the-whole-movement-in-view" / "do-work" / "frame_the_movement.py"

Measure = Callable[[str, float, float], dict[str, Any]]


def load_measure_tool(path: Path = MEASURE_TOOL):
    if not path.is_file():
        raise FileNotFoundError(f"the frame-the-whole-movement-in-view tool is not at {path}")
    spec = importlib.util.spec_from_file_location("frame_the_movement", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_measure(settings: dict[str, Any], work: Path, tool: Any = None) -> Measure:
    """measure(video, start, end) -> {"source": [w, h], "frames": [{"t", "box", "subject"}]} through the measure tool,
    once per distinct (video, start, end)."""
    tool = tool or load_measure_tool()
    cache: dict[tuple[str, float, float], dict[str, Any]] = {}

    def measure(video: str, start: float, end: float) -> dict[str, Any]:
        key = (video, start, end)
        if key not in cache:
            folder = work / f"cell-{len(cache):04d}"
            request = {**settings, "video": video, "shots": [{"id": "cell", "start": start, "end": end}], "out": str(folder)}
            out = tool.measure(request)
            cache[key] = {"source": out["source"], "frames": out["shots"][0]["frames"]}
        return cache[key]

    return measure


def inside(box: list[float], crop: dict[str, float]) -> bool:
    return (box[0] >= crop["x"] and box[1] >= crop["y"] and box[2] <= crop["x"] + crop["w"] and box[3] <= crop["y"] + crop["h"])


def crossings(frames: list[dict[str, Any]], crop: dict[str, float]) -> dict[str, Any]:
    """Frames whose boxes cross the crop edge. subject_crossing is the body alone; extent_crossing is the body or the
    racket (the extent holds both), so the body's frames are a subset of it."""
    subject, extent, undetected = [], [], 0
    for frame in frames:
        if frame.get("box") is None:
            undetected += 1
            continue
        if frame.get("subject") is not None and not inside(frame["subject"], crop):
            subject.append(frame["t"])
        if not inside(frame["box"], crop):
            extent.append(frame["t"])
    return {"subject": subject, "extent": extent, "undetected": undetected}


WHEN_TOO_WIDE = ("fit-blurred", "refuse")


def widen(crop: dict[str, float], aspect: float, frames: list[dict[str, Any]], source: list[int], margin: float,
          cell: list[int] | None = None, when_too_wide: str = "refuse") -> dict[str, Any]:
    """The smallest crop at `aspect`, no smaller than `crop`, inside the source, holding every box plus margin, nearest
    to the old crop's place. Returns {"crop": {...}}, {"crop": {...}, "fit": {...}} when no crop of that shape fits the
    source and `when_too_wide` is fit-blurred (the cell size `cell` is known), or {"refusal": why}."""
    boxes = [f["box"] for f in frames if f.get("box") is not None]
    if not boxes:
        return {"refusal": "no subject was detected in this cell's range, so there is nothing to fit"}
    src_w, src_h = source
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    x1, y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
    pad_x, pad_y = (x1 - x0) * margin, (y1 - y0) * margin
    x0, y0 = max(0.0, x0 - pad_x), max(0.0, y0 - pad_y)
    x1, y1 = min(float(src_w), x1 + pad_x), min(float(src_h), y1 + pad_y)
    need_h = max(crop["h"], y1 - y0, (x1 - x0) / aspect, crop["w"] / aspect)
    height = math.ceil(need_h)
    while True:
        width = round(height * aspect)
        if width >= x1 - x0 and height >= y1 - y0:
            break
        height += 1
    if width > src_w or height > src_h:
        too_wide = (f"the movement needs {math.ceil(x1 - x0)} by {math.ceil(y1 - y0)} px (a {width} by {height} crop at the "
                    f"cell aspect), which does not fit the {src_w} by {src_h} source frame")
        if when_too_wide == "fit-blurred" and cell:
            return fitted(x0, y0, x1, y1, min(width, src_w), min(height, src_h), source, cell, frames)
        return {"refusal": too_wide + ("" if cell else "; a fit needs the cell size (the edit's encode and layout)")}
    x = min(max(crop["x"] + crop["w"] / 2 - width / 2, x1 - width), x0)
    y = min(max(crop["y"] + crop["h"] / 2 - height / 2, y1 - height), y0)
    x = int(min(max(math.floor(x), 0), src_w - width))
    y = int(min(max(math.floor(y), 0), src_h - height))
    widened = {"w": width, "h": height, "x": x, "y": y}
    if crossings(frames, widened)["extent"]:
        return {"refusal": "the widened crop still lets a box cross its edge after rounding to whole pixels"}
    return {"crop": widened}


def fitted(x0: float, y0: float, x1: float, y1: float, width: int, height: int, source: list[int], cell: list[int],
           frames: list[dict[str, Any]]) -> dict[str, Any]:
    """A crop of `width` by `height` (the cell's shape cut to the source) centred on the boxes x0..x1, y0..y1, shown
    whole: `inner` is its picture scaled into the cell (even sizes, centred), the rest of the cell the blurred fill."""
    src_w, src_h = source
    x = int(min(max(math.floor((x0 + x1) / 2 - width / 2), 0), src_w - width))
    y = int(min(max(math.floor((y0 + y1) / 2 - height / 2), 0), src_h - height))
    crop = {"w": int(width), "h": int(height), "x": x, "y": y}
    if crossings(frames, crop)["extent"]:
        return {"refusal": "the fitted crop still lets a box cross its edge after rounding to whole pixels"}
    scale = min(cell[0] / width, cell[1] / height)
    w, h = 2 * int(width * scale / 2), 2 * int(height * scale / 2)
    inner = {"w": w, "h": h, "x": (cell[0] - w) // 4 * 2, "y": (cell[1] - h) // 4 * 2}   # even: yuv420p places on 2s
    return {"crop": crop, "fit": {"fill": "blur", "cell": list(cell), "inner": inner}}


HELD_SPAN_S = 0.25  # long enough for the measure tool's 6 fps sampling to take the held frame


def cell_check(source: dict[str, Any], aspect: float, measure: Measure, margin: float, cell_size: list[int] | None = None,
               when_too_wide: str = "refuse") -> dict[str, Any]:
    start = float(source["in"])
    # a held frame (a still pass) carries `in` only: what shows is that one frame, measured on the short span from it
    end = float(source["out"]) if "out" in source else start + HELD_SPAN_S
    measured = measure(source["source"], start, end)
    crop = source["crop"]
    found = crossings(measured["frames"], crop)
    cell: dict[str, Any] = {
        "source": source["source"], "in": start, "out": end, "crop": crop, "frames": len(measured["frames"]),
        "undetected_frames": found["undetected"],
        "subject_crossing_frames": len(found["subject"]), "extent_crossing_frames": len(found["extent"]),
        "crossing_times": [round(start + t, 3) for t in found["extent"]],
    }
    if not found["extent"]:
        return {**cell, "ok": True, "widened": None, "fit": source.get("fit"), "refusal": None}
    result = widen(crop, aspect, measured["frames"], measured["source"], margin, cell_size, when_too_wide)
    return {**cell, "ok": False, "widened": result.get("crop"), "fit": result.get("fit"), "refusal": result.get("refusal")}


def check_edit(edit: dict[str, Any], measure: Measure, margin: float = 0.03, when_too_wide: str = "fit-blurred") -> dict[str, Any]:
    """Every cell of the edit's split segments, in order, and the edit with the widened (or fitted) crops applied."""
    if when_too_wide not in WHEN_TOO_WIDE:
        raise ValueError(f"when_too_wide must be one of {', '.join(WHEN_TOO_WIDE)}, not {when_too_wide!r}")
    encode = edit.get("encode", {})
    fixed = copy.deepcopy(edit)
    cells = []
    for s_index, segment in enumerate(edit["spine"]["segments"]):
        for c_index, source in enumerate(segment.get("sources", [])):
            crop = source["crop"]
            layout = segment.get("layout")
            size = None
            if layout in ("h", "v") and encode.get("width") and encode.get("height"):
                aspect = cell_aspect(layout, encode["width"], encode["height"])
                size = [encode["width"] // 2, encode["height"]] if layout == "h" else [encode["width"], encode["height"] // 2]
            else:
                aspect = crop["w"] / crop["h"]
            cell = cell_check(source, aspect, measure, margin, size, when_too_wide)
            cell = {"segment": segment.get("id", s_index), "cell": c_index, **cell}
            cells.append(cell)
            if cell["widened"]:
                fixed_source = fixed["spine"]["segments"][s_index]["sources"][c_index]
                fixed_source["crop"] = cell["widened"]
                if cell["fit"]:
                    fixed_source["fit"] = cell["fit"]
                else:
                    fixed_source.pop("fit", None)      # a crop of the cell's shape fills the cell itself
    refused = [c for c in cells if c["refusal"]]
    return {"cells": cells, "cells_out_of_frame": sum(1 for c in cells if not c["ok"]), "cells_refused": len(refused),
            "passes": all(c["ok"] for c in cells), "fixed_edit": fixed}


def main(argv: list[str] | None = None, measure: Measure | None = None) -> int:
    parser = argparse.ArgumentParser(description="check each comparison cell keeps the whole body and racket in its crop")
    parser.add_argument("--edit", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--work", help="folder for the measure tool's per-cell boxes (default: beside the edit)")
    parser.add_argument("--write-edit", help="write the edit with widened crops to this path")
    parser.add_argument("--subject-class", type=int, default=0)
    parser.add_argument("--implement-class", type=int, default=38)
    parser.add_argument("--sample-fps", type=float, default=6)
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--conf", type=float, default=0.2)
    parser.add_argument("--near-px", type=float, default=400)
    parser.add_argument("--margin", type=float, default=0.03)
    parser.add_argument("--when-too-wide", choices=WHEN_TOO_WIDE, default="fit-blurred",
                        help="a movement no crop of the cell's shape can hold: fit it whole over a blurred fill, or refuse")
    args = parser.parse_args(argv)
    try:
        edit = json.loads(Path(args.edit).read_text(encoding="utf-8"))
        if measure is None:
            settings = {"command": "measure", "model": args.model, "subject_class": args.subject_class,
                        "implement_class": args.implement_class, "sample_fps": args.sample_fps, "imgsz": args.imgsz,
                        "conf": args.conf, "near_px": args.near_px}
            work = Path(args.work) if args.work else Path(args.edit).with_suffix(".framing")
            measure = make_measure(settings, work)
        report = check_edit(edit, measure, args.margin, args.when_too_wide)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}))
        return 2
    fixed = report.pop("fixed_edit")
    if args.write_edit:
        Path(args.write_edit).parent.mkdir(parents=True, exist_ok=True)
        Path(args.write_edit).write_text(json.dumps(fixed, indent=2), encoding="utf-8")
        report["written_edit"] = args.write_edit
    print(json.dumps({"result": report}))
    return 1 if report["cells_refused"] else 0


if __name__ == "__main__":
    sys.exit(main())
