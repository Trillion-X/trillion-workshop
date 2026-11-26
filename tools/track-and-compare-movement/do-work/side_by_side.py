"""Make a contact-synced side-by-side of one stroke from two recordings, and check one before it may be called a comparison.

USAGE: side_by_side.py make  --spec SPEC.json --out CLIP.mp4
       side_by_side.py check --spec SPEC.json --clip CLIP.mp4 [--sheet SHEET.jpg]

SPEC (DATA; nothing about a person, a sport or a page is in this file):
{
  "top":    {"source": "a.mp4", "fps": 29.97002997, "contact_frame": 94, "crop": [1215, 1080, 193, 0], "mirror": true,
             "stroke": "forehand", "hand": "right", "camera": "behind", "stroke_seen": "frames 90-99 looked at: ball on the strings at 94"},
  "bottom": {"source": "b.mp4", "fps": 119.88011988, "contact_frame": 492, "crop": [1080, 960, 260, 120], "mirror": false,
             "stroke": "forehand", "hand": "left", "camera": "behind", "stroke_seen": "..."},
  "cell": [1080, 960], "fps": 30, "before_s": 1.5, "after_s": 1.3, "encode": {"crf": 18, "preset": "slow"}
}
contact_frame is the source frame where the ball first sits on the strings, read by eye; stroke is read from frames
(never from a file name) and stroke_seen says which frames were looked at. hand is the hitting hand; camera is
"behind" (the camera sees the player's back) or "facing" (the player faces the camera).

make: each cell is cut by frame number and its contact frame is given the time of output frame K = round(before*fps)
exactly, so the output shows that very source frame at K on both cells, whatever each source's frame rate. Both cells
run at real speed. A cell is the source's own pixels: a crop smaller than the cell (an upscale) is refused. The window
is shortened to what both sources hold.

check (the gate for a format that says comparison; each check answers pass and what it measured):
- is-a-comparison: two sides whose source bytes differ, and each output cell, at K, matches its own source's contact
  frame (PSNR >= min_match_db); a solo cut or someone's own edit does not.
- same-stroke: both sides name the same stroke and say which frames it was read from.
- same-hitting-direction: the direction a stroke travels on screen follows from the hand, where the camera stands
  and the mirror; both cells must travel the same way.
- contact-in-sync: the output frame that best matches each source's contact frame, searched K-3..K+3; the two must be
  within max_offset_frames (1) of each other. The offset is answered in frames and ms.
--sheet writes the frames a reviewer looks at: start, racket back (K-15), K-1, K, K+1, follow-through (K+12), end.
Last line: {"result": ...} or {"error": ...}.
"""
import argparse
import hashlib
import json
import math
import subprocess
import sys

import numpy as np

CHECK = {"min_match_db": 35.0, "max_offset_frames": 1, "search": 3}


def window(spec, counts):
    """Seconds before and after contact that both sources hold, capped by the spec, in whole output frames."""
    fps = spec.get("fps", 30)
    before, after = float(spec.get("before_s", 1.5)), float(spec.get("after_s", 1.3))
    for name in ("top", "bottom"):
        side = spec[name]
        before = min(before, (side["contact_frame"] - 1) / side["fps"])
        after = min(after, (counts[name] - 1 - side["contact_frame"]) / side["fps"])
    if before <= 0 or after <= 0:
        raise ValueError("a source holds no frames on one side of its contact")
    return math.floor(before * fps) / fps, math.floor(after * fps) / fps


def cell_filter(side, cell, fps, before, after):
    """One cell, by frame number: the contact frame lands at the time of output frame round(before * fps)."""
    k = round(before * fps)
    pre, post = round(before * side["fps"]), round(after * side["fps"])
    cw, ch, cx, cy = side["crop"]
    if cw < cell[0] or ch < cell[1]:
        raise ValueError(f"crop {cw}x{ch} is smaller than the {cell[0]}x{cell[1]} cell: it would be scaled up")
    chain = [f"trim=start_frame={side['contact_frame'] - pre}:end_frame={side['contact_frame'] + post + 1}",
             f"setpts=((N-{pre})/{side['fps']!r}+{k}/{fps})/TB", f"crop={cw}:{ch}:{cx}:{cy}"]
    if (cw, ch) != tuple(cell):
        chain.append(f"scale={cell[0]}:{cell[1]}:flags=lanczos")
    if side.get("mirror"):
        chain.append("hflip")
    chain += [f"fps={fps}:start_time=0:round=near", "setsar=1"]
    return ",".join(chain)


def frame_count(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
                          "stream=nb_read_packets", "-of", "csv=p=0", path], capture_output=True, text=True, check=True).stdout
    return int(out.strip())


def make(spec, out):
    cell, fps = spec.get("cell", [1080, 960]), spec.get("fps", 30)
    before, after = window(spec, {n: frame_count(spec[n]["source"]) for n in ("top", "bottom")})
    enc = {"crf": 18, "preset": "slow", **spec.get("encode", {})}
    graph = (f"[0:v]{cell_filter(spec['top'], cell, fps, before, after)}[t];"
             f"[1:v]{cell_filter(spec['bottom'], cell, fps, before, after)}[b];[t][b]vstack=2,format=yuv420p[v]")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", spec["top"]["source"], "-i", spec["bottom"]["source"],
                    "-filter_complex", graph, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", str(enc["preset"]),
                    "-crf", str(enc["crf"]), "-r", str(fps), "-movflags", "+faststart", out], check=True)
    return {"out": out, "before_s": before, "after_s": after, "contact_output_frame": round(before * fps)}


def screen_direction(side):
    """+1 or -1: which way a forehand travels on screen. A right hand seen from behind is +1; the other hand, a
    camera the player faces, and a mirror each turn it round."""
    sign = 1 if side["hand"] == "right" else -1
    sign *= 1 if side["camera"] == "behind" else -1
    return -sign if side.get("mirror") else sign


def labels(spec):
    """The checks read from the spec alone: same stroke, read from frames; same hitting direction."""
    top, bottom = spec["top"], spec["bottom"]
    seen = all(str(s.get("stroke_seen", "")).strip() for s in (top, bottom))
    same_stroke = bool(top.get("stroke")) and top.get("stroke") == bottom.get("stroke") and seen
    return {
        "same-stroke": {"pass": same_stroke, "top": top.get("stroke"), "bottom": bottom.get("stroke"), "read_from_frames": seen},
        "same-hitting-direction": {"pass": screen_direction(top) == screen_direction(bottom),
                                   "top": screen_direction(top), "bottom": screen_direction(bottom)},
    }


def gray(cmd, shape):
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(out, np.uint8).astype(np.float32).reshape((-1,) + shape)


def psnr(a, b):
    mse = float(np.mean((a - b) ** 2))
    return 99.0 if mse == 0 else 10 * math.log10(255 ** 2 / mse)


def source_contact(side, cell):
    cw, ch, cx, cy = side["crop"]
    vf = f"select='eq(n\\,{side['contact_frame']})',crop={cw}:{ch}:{cx}:{cy},scale={cell[0]}:{cell[1]}:flags=lanczos"
    vf += ",hflip" if side.get("mirror") else ""
    return gray(["ffmpeg", "-v", "error", "-i", side["source"], "-vf", vf, "-frames:v", "1", "-f", "rawvideo",
                 "-pix_fmt", "gray", "-"], (cell[1], cell[0]))[0]


def clip_cells(clip, first, last, cell, row, layout="v"):
    """The output's cell `row` (0 = top / left) over frames first..last; layout "h" puts the cells side by side."""
    x, y = (row * cell[0], 0) if layout == "h" else (0, row * cell[1])
    vf = f"select='between(n\\,{first}\\,{last})',crop={cell[0]}:{cell[1]}:{x}:{y}"
    return gray(["ffmpeg", "-v", "error", "-i", clip, "-vf", vf, "-fps_mode", "passthrough", "-f", "rawvideo",
                 "-pix_fmt", "gray", "-"], (cell[1], cell[0]))


def blake3_or_sha(path):
    try:
        return "1f:" + subprocess.run(["b3sum", "--no-names", path], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        with open(path, "rb") as handle:
            return "sha256:" + hashlib.sha256(handle.read()).hexdigest()


def check(spec, clip, limits=None):
    limits = {**CHECK, **(limits or {})}
    cell, fps = spec.get("cell", [1080, 960]), spec.get("fps", 30)
    before, _ = window(spec, {n: frame_count(spec[n]["source"]) for n in ("top", "bottom")})
    k, s = round(before * fps), limits["search"]
    found = {}
    for row, name in enumerate(("top", "bottom")):
        scores = [round(psnr(source_contact(spec[name], cell), c), 2) for c in clip_cells(clip, k - s, k + s, cell, row, spec.get("layout", "v"))]
        best = int(np.argmax(scores))
        found[name] = {"frame": k - s + best, "match_db": scores[best], "scores": scores}
    distinct = blake3_or_sha(spec["top"]["source"]) != blake3_or_sha(spec["bottom"]["source"])
    matched = all(found[n]["match_db"] >= limits["min_match_db"] for n in found)
    offset = found["top"]["frame"] - found["bottom"]["frame"]
    checks = {
        "is-a-comparison": {"pass": distinct and matched, "sources_differ": distinct,
                            "cells_match_their_sources_db": {n: found[n]["match_db"] for n in found}},
        **labels(spec),
        "contact-in-sync": {"pass": matched and abs(offset) <= limits["max_offset_frames"], "expected_frame": k,
                            "top_frame": found["top"]["frame"], "bottom_frame": found["bottom"]["frame"],
                            "offset_frames": offset, "offset_ms": round(offset * 1000 / fps, 1)},
    }
    return {"pass": all(c["pass"] for c in checks.values()), "contact_output_frame": k, "checks": checks}


def sheet(clip, k, out, width=360):
    last = frame_count(clip) - 1
    picks = sorted({0, max(0, k - 15), k - 1, k, k + 1, min(last, k + 12), last})
    expr = "+".join(f"eq(n\\,{p})" for p in picks)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", clip, "-vf", f"select='{expr}',scale={width}:-2,tile={len(picks)}x1",
                    "-frames:v", "1", out], check=True)
    return {"sheet": out, "frames": picks}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["make", "check"])
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out")
    ap.add_argument("--clip")
    ap.add_argument("--sheet")
    a = ap.parse_args()
    try:
        spec = json.load(open(a.spec))
        if a.action == "make":
            if not a.out:
                raise ValueError("make needs --out")
            result = make(spec, a.out)
        else:
            if not a.clip:
                raise ValueError("check needs --clip")
            result = check(spec, a.clip)
            if a.sheet:
                result["sheet"] = sheet(a.clip, result["contact_output_frame"], a.sheet)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}))
        return 2
    print(json.dumps({"result": result}))
    return 0 if a.action == "make" or result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
