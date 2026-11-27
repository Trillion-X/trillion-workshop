#!/usr/bin/env python3
"""Retime a reference swing so its four landmarks play on the same output frames as the target swing's.

PURPOSE: a comparison plays the target as recorded and retimes the reference. swing_landmarks.py reads four moments of
each swing from its pose track (L1 takeback start, L2 furthest back, L3 contact as given, L4 finish). The reference is
retimed piecewise-linearly so that each of its landmarks lands on the output frame of the target's same landmark. So
the takeback starts together, the takebacks end together, contact meets contact and the finishes meet.

HOW:
1. Each side's landmarks come from its own pose track around its own contact (swing_landmarks.find_landmarks). There
   is no fixed window: each side's window runs from its L1 minus `lead_s` to its L4 plus `tail_s` (the reference's lead
   and tail are the target's played at the speed of the reference's first and last piece). A lead or tail is shortened
   where a track or clip ends.
2. Three pieces, each at one constant speed (reference seconds per target second): window start..L2 (L1 lies on it),
   L2..L3, L3..window end (L4 lies on it).
3. A piece outside [min_speed, max_speed] is refused: the two swings cannot be synced without distortion, and a wrong
   sync makes a misleading comparison. A side whose landmarks cannot be read (a wrong contact, a track that starts
   mid-takeback or stops mid-follow-through) is refused the same way, never guessed.
4. The error is the landmark misses: for each landmark, how many output frames apart the target and the retimed
   reference reach it, read back through the written pieces. It is never scored on the features of a matcher.
5. With both clips given, a landmark sheet is written: both people's frames at L1..L4 side by side, labelled, for a
   person to check that each pair shows the same moment. The numbers cannot show that; the sheet can.

Every number is DATA in phase-sync.json beside this file; a spec's `settings` overrides any of them (its `landmarks`
object overrides the landmark rules).

USAGE: phase_sync.py --spec SPEC.json --out SYNC.json [--sheet SHEET.png]
SPEC.json:
{
  "fps": 30,                                              output frames per second (misses are counted in these)
  "target":    {"kp": "t.pose.json", "contact": 4.1, "track_id": 1, "clip": "t.mp4"},   plays as recorded
  "reference": {"kp": "r.pose.json", "contact": 11.0, "clip": "r.mp4"},                 is retimed
  "settings": {"max_speed": 3},                           optional overrides of phase-sync.json
  "sheet": "sheet.png"                                    optional; written when both sides give `clip`
}
`contact` is the source second of each clip's contact; `track_id` picks the person (the main player when absent);
`clip` is the video the pose track was made from (only the sheet reads it). The window comes from the landmarks, so a
side's `in`/`out` are refused.
OUTPUT (SYNC.json, kind phase_sync.v1):
{
  "kind": "phase_sync.v1",
  "target":    {"in", "contact", "out"},  "reference": {"in", "contact", "out"},
  "landmarks": {"target": {"L1", "L2", "L3", "L4"}, "reference": {...}},     source seconds of each clip
  "pieces": [{"from": s, "to": s, "plays_from": s, "plays_to": s, "speed": x}],
      from/to = reference source seconds; plays_from/plays_to = output seconds from the cell's start at 1x
  "speed_ramp": [{"t": s, "speed": x}],    the same pieces as the renderer's speed envelope: t = reference seconds
                                           from the reference `in`, each speed holding until the next t
  "landmark_misses_frames": {"L1": e, ...},  "max_phase_error_frames": the largest miss,
  "landmark_sheet": "sheet.png" (when made),  "settings": {...}
}
The last line printed is {"result": ...} or {"error": ..., "refused": {...}}.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import swing_landmarks  # noqa: E402  (the one landmark reader: its rules are reused, not copied)
import whole_swing_map  # noqa: E402  (every moment matched by pose, pinned at contact)

SETTINGS = json.loads((HERE / "phase-sync.json").read_text(encoding="utf-8"))
KEYS = ("L1", "L2", "L3", "L4")


class Refused(ValueError):
    """The pair cannot be synced within the settings; `facts` say which side or piece and why."""

    def __init__(self, message: str, facts: dict[str, Any]):
        super().__init__(message)
        self.facts = facts


def read_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def read_side(side: dict[str, Any], name: str, landmark_settings: dict[str, Any]) -> dict[str, Any]:
    """One side's pose frames, landmarks and the seconds its track covers."""
    for key in ("in", "out"):
        if key in side:
            raise ValueError(f"the {name} gives `{key}`; the window comes from the swing's landmarks, so give only kp, contact, track_id and clip")
    track = read_json(side["kp"])
    frames = swing_landmarks.person_frames(track, side.get("track_id"))
    try:
        landmarks = swing_landmarks.find_landmarks(frames, float(side["contact"]), landmark_settings)
    except swing_landmarks.NoLandmark as missing:
        raise Refused(f"the {name}: {missing}", {"side": name, **missing.facts}) from missing
    seconds = [float(frame["t"]) for frame in frames]
    return {"track": track, "frames": frames, "landmarks": landmarks, "from": min(seconds), "to": max(seconds)}


def phase_sync(spec: dict[str, Any]) -> dict[str, Any]:
    settings = {**SETTINGS, **{key: value for key, value in (spec.get("settings") or {}).items() if key != "landmarks"}}
    settings["landmarks"] = {**SETTINGS["landmarks"], **((spec.get("settings") or {}).get("landmarks") or {})}
    fps = float(spec.get("fps", 30))
    target = read_side(spec["target"], "target", settings["landmarks"])
    reference = read_side(spec["reference"], "reference", settings["landmarks"])
    t = [target["landmarks"][key] for key in KEYS]
    r = [reference["landmarks"][key] for key in KEYS]
    speeds = [(r[k + 1] - r[k]) / (t[k + 1] - t[k]) for k in range(3)]       # L1..L2, L2..L3, L3..L4
    names = ("start..L2", "L2..L3", "L3..end")
    for index, speed in enumerate(speeds):
        if not settings["min_speed"] <= speed <= settings["max_speed"]:
            raise Refused(f"piece {names[index]} would play the reference at {speed:.3g}x, outside {settings['min_speed']}x..{settings['max_speed']}x; "
                          "these two swings cannot be synced without distorting the reference",
                          {"piece": index, "speed": round(speed, 6), "min_speed": settings["min_speed"], "max_speed": settings["max_speed"],
                           "landmarks": {"target": dict(zip(KEYS, t)), "reference": dict(zip(KEYS, r))}})

    if (settings.get("pose_map") or {}).get("use"):  # the landmarks' speeds are checked first: a swing that would need
        return by_pose(spec, settings, fps, target, reference)  # more than the bounds is refused, never clamped into a wrong sync
    # Lead before L1 and tail after L4: the target's seconds, played by the reference at its first / last piece's
    # speed, shortened where either track ends (a clip has no frames before its first pose frame either).
    lead = min(float(settings["lead_s"]), t[0] - target["from"], (r[0] - max(reference["from"], 0.0)) / speeds[0])
    tail = min(float(settings["tail_s"]), target["to"] - t[3], (reference["to"] - r[3]) / speeds[2])
    lead, tail = max(lead, 0.0), max(tail, 0.0)
    knots_t = [t[0] - lead, t[1], t[2], t[3] + tail]
    knots_r = [r[0] - lead * speeds[0], r[1], r[2], r[3] + tail * speeds[2]]
    pieces = []
    for k in range(3):
        pieces.append({"from": round(knots_r[k], 6), "to": round(knots_r[k + 1], 6),
                       "plays_from": round(knots_t[k] - knots_t[0], 6), "plays_to": round(knots_t[k + 1] - knots_t[0], 6),
                       "speed": round(speeds[k], 6)})
    sync = {
        "kind": "phase_sync.v1",
        "target": {"in": round(knots_t[0], 6), "contact": round(t[2], 6), "out": round(knots_t[3], 6)},
        "reference": {"in": round(knots_r[0], 6), "contact": round(r[2], 6), "out": round(knots_r[3], 6)},
        "landmarks": {"target": dict(zip(KEYS, t)), "reference": dict(zip(KEYS, r))},
        "pieces": pieces,
        "speed_ramp": [{"t": round(piece["from"] - knots_r[0], 6), "speed": piece["speed"]} for piece in pieces],
        "settings": settings,
    }
    misses = landmark_misses(sync, fps)
    sync["landmark_misses_frames"] = misses
    sync["max_phase_error_frames"] = max(misses.values())
    if sync["max_phase_error_frames"] > settings["refuse_above_frames"]:
        raise Refused(f"a landmark is missed by {sync['max_phase_error_frames']:.2f} output frames (refused above {settings['refuse_above_frames']})",
                      {"landmark_misses_frames": misses, "pieces": pieces})
    if spec.get("sheet"):
        clips = [spec[name].get("clip") for name in ("target", "reference")]
        if not all(clips):
            raise ValueError("a landmark sheet needs both sides' `clip` (the videos the pose tracks were made from)")
        rows = [{"name": name, "clip": spec[name]["clip"], "frames": side["frames"], "landmarks": side["landmarks"],
                 **swing_landmarks.video_facts(side["track"])} for name, side in (("target", target), ("reference", reference))]
        sync["landmark_sheet"] = swing_landmarks.landmark_sheet(rows, spec["sheet"], settings["landmarks"])
    return sync


def by_pose(spec: dict[str, Any], settings: dict[str, Any], fps: float, target: dict[str, Any], reference: dict[str, Any]) -> dict[str, Any]:
    """The reference follows the target moment by moment: one constant-speed piece between each two knots of the
    pose map. Contact meets contact exactly; the landmarks are reported (where the pose map and the landmark rules
    disagree is shown, not refused, because the pose map is the better reading of the moments between them)."""
    s = {**settings["pose_map"], "min_speed": settings["min_speed"], "max_speed": settings["max_speed"]}
    try:
        found = whole_swing_map.pose_map(target, reference, settings["landmarks"], s)
    except swing_landmarks.NoLandmark as missing:
        raise Refused(f"the pose map: {missing}", dict(missing.facts)) from missing
    kt, kr = found["t"], found["r"]
    pieces = []
    for k in range(len(kt) - 1):
        speed = (kr[k + 1] - kr[k]) / (kt[k + 1] - kt[k])
        pieces.append({"from": round(kr[k], 6), "to": round(kr[k + 1], 6), "plays_from": round(kt[k] - kt[0], 6),
                       "plays_to": round(kt[k + 1] - kt[0], 6), "speed": round(speed, 6)})
    tl, rl = target["landmarks"], reference["landmarks"]
    sync = {
        "kind": "phase_sync.v1",
        "align": "pose",
        "target": {"in": round(kt[0], 6), "contact": round(tl["L3"], 6), "out": round(kt[-1], 6)},
        "reference": {"in": round(kr[0], 6), "contact": round(rl["L3"], 6), "out": round(kr[-1], 6)},
        "landmarks": {"target": {key: tl[key] for key in KEYS}, "reference": {key: rl[key] for key in KEYS}},
        "pieces": pieces,
        "speed_ramp": [{"t": round(piece["from"] - kr[0], 6), "speed": piece["speed"]} for piece in pieces],
        "pose_distance": found["pose_distance"],
        "settings": settings,
    }
    misses = landmark_misses(sync, fps)
    sync["landmark_misses_frames"] = misses
    sync["max_phase_error_frames"] = misses["L3"]                # the one moment fixed by the caller
    if misses["L3"] > settings["refuse_above_frames"]:
        raise Refused(f"contact is missed by {misses['L3']:.2f} output frames", {"landmark_misses_frames": misses})
    if spec.get("sheet"):
        clips = [spec[name].get("clip") for name in ("target", "reference")]
        if not all(clips):
            raise ValueError("a sheet needs both sides' `clip` (the videos the pose tracks were made from)")
        count = int(settings["pose_map"]["sheet_moments"])
        moments_t = [kt[0] + (kt[-1] - kt[0]) * k / (count - 1) for k in range(count)]
        at = lambda second: kt[0] + plays_at(sync, second)  # noqa: E731
        rows = [{"name": "target", "clip": clips[0], "frames": target["frames"], "landmarks": tl,
                 "moments": [(f"+{m - kt[0]:.2f} s", m) for m in moments_t], **swing_landmarks.video_facts(target["track"])},
                {"name": "reference", "clip": clips[1], "frames": reference["frames"], "landmarks": rl,
                 "moments": [(f"+{m - kt[0]:.2f} s", reference_second(sync, m)) for m in moments_t], **swing_landmarks.video_facts(reference["track"])}]
        del at
        sync["landmark_sheet"] = swing_landmarks.landmark_sheet(rows, spec["sheet"], settings["landmarks"])
    return sync


def landmark_misses(sync: dict[str, Any], fps: float) -> dict[str, float]:
    """For each landmark, the output frames between the target reaching it (it plays as recorded) and the retimed
    reference reaching it, read back through the written (rounded) pieces."""
    misses = {}
    for key in KEYS:
        target_plays = sync["landmarks"]["target"][key] - sync["target"]["in"]
        misses[key] = round(abs(plays_at(sync, sync["landmarks"]["reference"][key]) - target_plays) * fps, 3)
    return misses


def plays_at(sync: dict[str, Any], reference_second: float) -> float:
    """The output second (from the cell's start) at which the retimed reference shows `reference_second`."""
    for piece in sync["pieces"]:
        if reference_second <= piece["to"] + 1e-9:
            return piece["plays_from"] + (max(reference_second, piece["from"]) - piece["from"]) / piece["speed"]
    return sync["pieces"][-1]["plays_to"]


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
    parser = argparse.ArgumentParser(description="two swings -> constant-speed pieces that land the reference's landmarks on the target's")
    parser.add_argument("--spec", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--sheet", help="where to write the landmark sheet (default: beside OUT when both sides give `clip`)")
    args = parser.parse_args()
    try:
        spec = read_json(args.spec)
        if args.sheet:
            spec["sheet"] = args.sheet
        elif not spec.get("sheet") and spec["target"].get("clip") and spec["reference"].get("clip"):
            spec["sheet"] = str(Path(args.out).with_suffix("")) + ".landmarks.png"
        result = phase_sync(spec)
    except Refused as refusal:
        print(json.dumps({"error": str(refusal), "refused": refusal.facts}))
        return 1
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}; check the spec against the shape in the file's header"}))
        return 2
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"result": {"out": args.out, "pieces": len(result["pieces"]), "max_phase_error_frames": result["max_phase_error_frames"],
                                 "landmark_misses_frames": result["landmark_misses_frames"], "landmarks": result["landmarks"],
                                 **({"landmark_sheet": result["landmark_sheet"]} if "landmark_sheet" in result else {})}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
