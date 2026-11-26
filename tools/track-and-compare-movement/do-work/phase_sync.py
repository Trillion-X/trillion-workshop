#!/usr/bin/env python3
"""Turn the phase alignment of two swing windows into a few constant-speed pieces for the reference, so its swing
arrives at each phase at the same moment as the target's.

PURPOSE: a comparison plays the target as recorded and retimes the reference. Contact is pinned: the reference's
contact second plays at exactly the output moment the target's contact second plays. Before and after contact the
reference plays a small number of pieces, each at one constant speed, chosen so the reference follows the posture
alignment of align_dtw.py (the one phase matcher; nothing here matches postures itself).

HOW:
1. Each window is cut in two at its contact second (start..contact and contact..end), and each half of the target is
   aligned to the same half of the reference with align_dtw's features and DTW. So contact meets contact by
   construction and the window edges meet the window edges.
2. The alignment becomes a curve: for each target frame, the mean reference second the path pairs it with.
3. The pieces start as two (start..contact, contact..end). The piece whose curve is worst followed is cut at its worst
   point, again and again, until every target frame's phase is reached within `tolerance_frames` output frames, or
   `max_pieces` is reached. A cut never makes a piece shorter than `min_piece_seconds`.
4. Each piece's speed is reference seconds per target second (2 = the reference plays twice as fast). A speed outside
   [min_speed, max_speed], or a phase error still above `refuse_above_frames`, is refused: the pair cannot be synced
   without distortion, and a wrong sync would make a misleading comparison.

Every number is DATA in phase-sync.json beside this file; a spec's `settings` overrides any of them.

USAGE: phase_sync.py --spec SPEC.json --out SYNC.json
SPEC.json:
{
  "fps": 30,                                         output frames per second (the error is counted in these frames)
  "target":    {"kp": "t.pose.json", "in": 3.0, "contact": 4.1, "out": 5.0, "track_id": 1},   plays as recorded
  "reference": {"kp": "r.pose.json", "in": 10.2, "contact": 11.0, "out": 11.6},                 is retimed
  "settings": {"max_speed": 3}                       optional overrides of phase-sync.json
}
`in`/`contact`/`out` are source seconds of each clip; `track_id` picks the person (the most confident when absent).
OUTPUT (SYNC.json, kind phase_sync.v1):
{
  "kind": "phase_sync.v1",
  "target":    {"in", "contact", "out"},  "reference": {"in", "contact", "out"},
  "pieces": [{"from": s, "to": s, "plays_from": s, "plays_to": s, "speed": x}],
      from/to = reference source seconds; plays_from/plays_to = output seconds from the cell's start at 1x
  "speed_ramp": [{"t": s, "speed": x}],    the same pieces as the renderer's speed envelope: t = reference seconds
                                           from the reference `in`, each speed holding until the next t
  "max_phase_error_frames": e,  "settings": {...}
}
The last line printed is {"result": ...} or {"error": ..., "refused": {...}}.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import align_dtw  # noqa: E402  (the one phase matcher: its features and DTW are reused, not copied)

SETTINGS = json.loads((HERE / "phase-sync.json").read_text(encoding="utf-8"))


class Refused(ValueError):
    """The pair cannot be synced within the settings; `facts` say which piece and why."""

    def __init__(self, message: str, facts: dict[str, Any]):
        super().__init__(message)
        self.facts = facts


def person_frames(track: dict[str, Any], track_id: int | None) -> list[dict[str, Any]]:
    if track_id is None:
        return align_dtw._primary_person(track)
    for person in track.get("persons") or []:
        if person.get("track_id") == track_id:
            return person.get("frames", [])
    raise ValueError(f"the pose track has no person with track_id {track_id}")


def posture_frames(frames: list[dict[str, Any]], start: float, end: float) -> tuple[np.ndarray, np.ndarray]:
    """The seconds and align_dtw features of the frames in [start, end] that show a torso."""
    times: list[float] = []
    rows: list[np.ndarray] = []
    for frame in frames:
        if not start - 1e-6 <= float(frame["t"]) <= end + 1e-6:
            continue
        feature = align_dtw._feature_matrix([frame])
        if len(feature):
            times.append(float(frame["t"]))
            rows.append(feature[0])
    return np.array(times, dtype=float), np.array(rows, dtype=float)


def half_curve(target: tuple[np.ndarray, np.ndarray], reference: tuple[np.ndarray, np.ndarray], gamma: float, what: str) -> tuple[np.ndarray, np.ndarray]:
    """For each target frame of one half, the mean reference second the alignment pairs it with."""
    (target_t, target_f), (reference_t, reference_f) = target, reference
    if len(target_f) < 2 or len(reference_f) < 2:
        raise Refused(f"the {what} has too few frames showing a torso to align (target {len(target_f)}, reference {len(reference_f)}; each needs 2)",
                      {"half": what, "target_frames": int(len(target_f)), "reference_frames": int(len(reference_f))})
    if not (np.isfinite(target_f).all() and np.isfinite(reference_f).all()):
        raise Refused(f"the {what} has a keypoint that is not a finite number", {"half": what})
    # The inputs are checked finite above; macOS's BLAS sets floating-point flags on a correct matmul, so numpy's
    # divide/overflow warnings inside align_dtw's cost matrix are noise here.
    with np.errstate(all="ignore"):
        path, _ = align_dtw._dtw(target_f, reference_f, gamma)
    paired: dict[int, list[float]] = {}
    for i, j in path:
        paired.setdefault(i, []).append(between_frames(target_f[i], reference_f, reference_t, j))
    return target_t[sorted(paired)], np.array([np.mean(paired[i]) for i in sorted(paired)])


def between_frames(posture: np.ndarray, reference_f: np.ndarray, reference_t: np.ndarray, j: int) -> float:
    """The reference second of the posture between frames: the path pairs a posture with a whole reference frame, so a
    reference played slower than the target repeats one frame; the parabola through the posture's cost at frames
    j-1, j and j+1 puts it between them (at most half a frame from j)."""
    if j == 0 or j == len(reference_f) - 1:
        return float(reference_t[j])
    before, at, after = (float(np.sum((posture - reference_f[k]) ** 2)) for k in (j - 1, j, j + 1))
    bend = before - 2 * at + after
    shift = 0.0 if bend <= 1e-12 else max(-0.5, min(0.5, (before - after) / (2 * bend)))
    return float(reference_t[j] + shift * (reference_t[j + 1] - reference_t[j - 1]) / 2)


def phase_curve(spec: dict[str, Any], gamma: float) -> tuple[np.ndarray, np.ndarray]:
    """target second -> reference second over the whole window, with in, contact and out meeting exactly."""
    target, reference = spec["target"], spec["reference"]
    target_frames = person_frames(read_json(target["kp"]), target.get("track_id"))
    reference_frames = person_frames(read_json(reference["kp"]), reference.get("track_id"))
    xs: list[float] = [float(target["in"])]
    ys: list[float] = [float(reference["in"])]
    for what, (t0, t1), (r0, r1) in (("part before contact", (target["in"], target["contact"]), (reference["in"], reference["contact"])),
                                     ("part after contact", (target["contact"], target["out"]), (reference["contact"], reference["out"]))):
        times, seconds = half_curve(posture_frames(target_frames, t0, t1), posture_frames(reference_frames, r0, r1), gamma, what)
        inside = (times > t0 + 1e-6) & (times < t1 - 1e-6)
        xs += list(times[inside]) + [float(t1)]
        ys += list(seconds[inside]) + [float(r1)]
    return np.array(xs), np.maximum.accumulate(np.array(ys))


def read_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def fit_pieces(xs: np.ndarray, ys: np.ndarray, contact: float, settings: dict[str, Any], fps: float) -> tuple[list[float], float]:
    """Knots (target seconds) of the piecewise-linear fit, and its worst phase error in output frames."""
    knots = [float(xs[0]), float(contact), float(xs[-1])]
    while True:
        fitted = np.interp(xs, knots, np.interp(knots, xs, ys))
        speeds = np.diff(np.interp(knots, xs, ys)) / np.diff(knots)
        piece = np.clip(np.searchsorted(knots, xs, side="right") - 1, 0, len(knots) - 2)
        # A reference that is e seconds off its phase reaches that phase e / speed output seconds early or late.
        error = np.abs(ys - fitted) / np.maximum(speeds[piece], 1e-9) * fps
        worst = float(error.max()) if len(error) else 0.0
        if worst <= settings["tolerance_frames"] or len(knots) - 1 >= settings["max_pieces"]:
            return knots, worst
        room = np.array([min(abs(x - k) for k in knots) >= settings["min_piece_seconds"] - 1e-9 for x in xs])
        if not (room & (error > settings["tolerance_frames"])).any():
            return knots, worst
        knots = sorted(knots + [float(xs[int(np.argmax(np.where(room, error, -1.0)))])])


def phase_sync(spec: dict[str, Any]) -> dict[str, Any]:
    settings = {**SETTINGS, **(spec.get("settings") or {})}
    fps = float(spec.get("fps", 30))
    target, reference = spec["target"], spec["reference"]
    for side, name in ((target, "target"), (reference, "reference")):
        if not float(side["in"]) < float(side["contact"]) < float(side["out"]):
            raise ValueError(f"the {name} needs in < contact < out (got {side['in']}, {side['contact']}, {side['out']})")
    xs, ys = phase_curve(spec, float(settings["gamma"]))
    knots, worst = fit_pieces(xs, ys, float(target["contact"]), settings, fps)
    # The knots' reference seconds; in, contact and out are points of the curve, so they are the given seconds exactly.
    seconds = [float(value) for value in np.interp(knots, xs, ys)]
    pieces = []
    for index in range(len(knots) - 1):
        speed = (seconds[index + 1] - seconds[index]) / (knots[index + 1] - knots[index])
        pieces.append({"from": round(seconds[index], 6), "to": round(seconds[index + 1], 6),
                       "plays_from": round(knots[index] - float(target["in"]), 6), "plays_to": round(knots[index + 1] - float(target["in"]), 6),
                       "speed": round(speed, 6)})
    for index, piece in enumerate(pieces):
        if not settings["min_speed"] <= piece["speed"] <= settings["max_speed"]:
            raise Refused(f"piece {index + 1} of {len(pieces)} would play the reference at {piece['speed']:.3g}x, outside {settings['min_speed']}x..{settings['max_speed']}x; "
                          "these two swings cannot be synced without distorting the reference",
                          {"piece": index, "speed": piece["speed"], "min_speed": settings["min_speed"], "max_speed": settings["max_speed"], "pieces": pieces})
    if worst > settings["refuse_above_frames"]:
        raise Refused(f"with {len(pieces)} pieces the reference still misses a phase by {worst:.2f} output frames (refused above {settings['refuse_above_frames']})",
                      {"max_phase_error_frames": round(worst, 3), "pieces": pieces})
    return {
        "kind": "phase_sync.v1",
        "target": {key: float(target[key]) for key in ("in", "contact", "out")},
        "reference": {key: float(reference[key]) for key in ("in", "contact", "out")},
        "pieces": pieces,
        "speed_ramp": [{"t": round(piece["from"] - float(reference["in"]), 6), "speed": piece["speed"]} for piece in pieces],
        "max_phase_error_frames": round(worst, 3),
        "settings": settings,
    }


def reference_second(sync: dict[str, Any], target_second: float) -> float:
    """Where the synced reference is when the target is at `target_second` (inside the sync's target window)."""
    plays = target_second - sync["target"]["in"]
    for piece in sync["pieces"]:
        if plays <= piece["plays_to"] + 1e-9:
            return piece["from"] + (max(plays, piece["plays_from"]) - piece["plays_from"]) * piece["speed"]
    return sync["pieces"][-1]["to"]


def reference_window(sync: dict[str, Any], target_from: float, target_to: float) -> dict[str, Any]:
    """The reference's source window and speed ramp for the part of the target window [target_from, target_to]:
    played through `speed_ramp` (t = reference seconds from `in`), it lasts exactly target_to - target_from seconds."""
    window = sync["target"]
    if not window["in"] - 1e-6 <= target_from < target_to <= window["out"] + 1e-6:
        raise ValueError(f"the target part {target_from}..{target_to} is not inside the synced window {window['in']}..{window['out']}")
    start = reference_second(sync, target_from)
    ramp = []
    for piece in sync["pieces"]:
        begins, ends = piece["plays_from"] + window["in"], piece["plays_to"] + window["in"]
        if ends > target_from + 1e-9 and begins < target_to - 1e-9:
            ramp.append({"t": round(reference_second(sync, max(begins, target_from)) - start, 6), "speed": piece["speed"]})
    return {"in": round(start, 6), "out": round(reference_second(sync, target_to), 6), "speed_ramp": ramp}


def main() -> int:
    parser = argparse.ArgumentParser(description="two swing windows -> constant-speed pieces that phase-sync the reference to the target")
    parser.add_argument("--spec", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    try:
        result = phase_sync(read_json(args.spec))
    except Refused as refusal:
        print(json.dumps({"error": str(refusal), "refused": refusal.facts}))
        return 1
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}; check the spec against the shape in the file's header"}))
        return 2
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"result": {"out": args.out, "pieces": len(result["pieces"]), "max_phase_error_frames": result["max_phase_error_frames"]}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
