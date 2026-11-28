#!/usr/bin/env python3
"""Whether a swing is made on the playing hand's side (a forehand) or across the body (a backhand), from what the
pose shows, for a recording filmed from any camera angle.

Why: a comparison must pair the same stroke. Pose distance between two different people cannot tell a forehand from
a backhand reliably (measured Nov 25 2026: a student's two-handed backhands sat closer to a pro's forehands than to
his one-handed backhands), and a pose model seen from behind can swap the body's left and right labels, so nothing
here is read by a left/right label. Two readings of one swing window, each from a different signal:

  by side   the takeback's side ON SCREEN. hitting wrist = the wrist that moves furthest over the last frames before
            contact (whichever label it carries); takeback side = from the window's start to contact, its horizontal
            offset from the hips' middle in body widths, the extreme with the larger size, signed (+ = screen right).
            With the swing's forehand side (+1: a forehand's takeback goes to screen right; -1: to screen left):
            forehand when side x forehand_side >= margin, backhand when <= -margin.
  by turn   which way the body turns. The window's body heading trajectory (describe_clip's `heading`, degrees,
            0 = back to the camera, 180 = chest to it) is unwrapped; the forward turn is its last heading minus the
            heading farthest from it (the furthest-turned point of the takeback). A turn is a rotation about the
            upright body, so its direction is the same from every camera azimuth: with the playing hand,
            forehand when turn x hand x right_hand_forehand_turn >= turn_min_deg, backhand when <= -turn_min_deg.
            A window describe_clip marks as cut at the clip's edge (full_swing false), or one ending less than
            turn_follow_min_s after contact (its last turn can be the takeback's), gives no turn reading.

The forehand side is a fact of how the swing was filmed. Given (a recording's or a library's forehand_side), it is
used as given. Otherwise it is derived per window from the heading and the playing hand: seen from behind, a right
hand's forehand goes to screen right, seen from the front to screen left, so
  forehand_side = hand x sign(cos(facing)), facing = the circular mean of the window's last facing_samples headings
(the follow-through, where the chest has turned back toward the target), only when |cos(facing)| >= facing_min_cos.
A camera at the player's side (cos near 0) decides nothing: the takeback goes behind the body for both strokes there.

  stroke = the one both readings give. A reading that cannot be made (no hand, no heading, a side view, a takeback
  near the middle, a small turn), or two readings that differ, is unclear (refused), never a guess. With a given
  forehand side and no playing hand, the side reading alone decides (the fixed per-side value as an override).
The numbers are DATA in stroke-side.json; a job may give its own (stroke_side_rules). Measured on labelled one-swing
clips of every camera angle: see the README.

USAGE: stroke_side.py --kp POSE.json --desc DESC.json --window N [--hand right|left] [--forehand-side 1|-1]
                      [--rules stroke-side.json]
Last line: {"result": {"side", "hitting_wrist", "forehand_side", "forehand_side_from", "turn", "by_side", "by_turn",
"stroke"}} or {"error": ...}.
"""
import argparse
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "process-scripts", "perception"))
from pose_schema import JI  # noqa: E402
from describe_clip import main_track  # noqa: E402  the same player the swing windows were found on

MIN_CONFIDENCE = 0.3
LAST_FRAMES = 6
RULES_FILE = os.path.join(HERE, "stroke-side.json")
HANDS = {"right": 1, "left": -1}


def rules_of(job=None):
    """stroke-side.json, with any of the job's own stroke_side_rules over it."""
    with open(RULES_FILE) as f:
        rules = json.load(f)
    return {**rules, **((job or {}).get("stroke_side_rules") or {})}


def takeback_side(kp, t0, contact):
    """(side, hitting wrist name) or (None, None) when too little of the body is seen."""
    person = main_track(kp)
    frames = [f for f in (person or {}).get("frames", []) if t0 <= f["t"] <= contact + 0.05]
    if len(frames) < 4:
        return None, None

    def travel(name):
        tail = frames[-LAST_FRAMES:]
        return sum(((a["kp"][JI[name]][0] - b["kp"][JI[name]][0]) ** 2 + (a["kp"][JI[name]][1] - b["kp"][JI[name]][1]) ** 2) ** 0.5
                   for a, b in zip(tail, tail[1:]))
    wrist = "l_wrist" if travel("l_wrist") > travel("r_wrist") else "r_wrist"
    offsets = []
    for f in frames:
        k = f["kp"]
        point = lambda n: k[JI[n]]  # noqa: E731
        if min(point(wrist)[2], point("l_hip")[2], point("r_hip")[2]) < MIN_CONFIDENCE:
            continue
        hips = (point("l_hip")[0] + point("r_hip")[0]) / 2
        width = max(abs(point("l_shoulder")[0] - point("r_shoulder")[0]), abs(point("l_hip")[0] - point("r_hip")[0]), 1.0)
        offsets.append((point(wrist)[0] - hips) / width)
    if not offsets:
        return None, None
    low, high = min(offsets), max(offsets)
    return round(high if abs(high) >= abs(low) else low, 3), wrist


def stroke_of(side, forehand_side, margin):
    """The side reading: forehand, backhand, or None (unclear)."""
    if side is None or forehand_side not in (1, -1):
        return None
    signed = side * forehand_side
    return "forehand" if signed >= margin else "backhand" if signed <= -margin else None


def _trajectory(heading):
    """The heading samples in order, or None when there are none or one is not a finite number."""
    traj = (heading or {}).get("traj") if isinstance(heading, dict) else None
    if not traj or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in traj):
        return None
    return traj


def forward_turn(heading):
    """Degrees the body turns from the furthest-turned point of the takeback to the window's end (signed, in the
    heading's own direction), or None without a trajectory of at least two samples."""
    traj = _trajectory(heading)
    if not traj or len(traj) < 2:
        return None
    unwrapped = [traj[0]]
    for a, b in zip(traj, traj[1:]):
        step = (b - a) % 360
        unwrapped.append(unwrapped[-1] + (step - 360 if step > 180 else step))
    end = unwrapped[-1]
    farthest = max(unwrapped[:-1], key=lambda h: abs(h - end))
    return round(end - farthest, 1)


def forehand_side_of(heading, hand, rules):
    """+1 / -1: which way this swing's forehand goes on screen, from the playing hand and whether the camera is
    behind (cos(facing) > 0) or in front; None when the camera is near the player's side or a fact is missing."""
    traj = _trajectory(heading)
    if not traj or hand not in HANDS:
        return None
    last = traj[-int(rules["facing_samples"]):]
    facing = math.atan2(sum(math.sin(math.radians(h)) for h in last), sum(math.cos(math.radians(h)) for h in last))
    if abs(math.cos(facing)) < float(rules["facing_min_cos"]):
        return None
    return HANDS[hand] * (1 if math.cos(facing) > 0 else -1)


def stroke_by_turn(turn, hand, rules):
    """The turn reading: forehand, backhand, or None (unclear)."""
    if turn is None or hand not in HANDS:
        return None
    signed = turn * HANDS[hand] * int(rules["right_hand_forehand_turn"])
    least = float(rules["turn_min_deg"])
    return "forehand" if signed >= least else "backhand" if signed <= -least else None


def read_stroke(kp, window, hand=None, forehand_side=None, rules=None):
    """Both readings of one swing window and the stroke they agree on (None = unclear). `window` is a descriptor
    window (t0, peak_t, heading); `hand` the player's playing hand (right/left); `forehand_side` a given override."""
    rules = rules or rules_of()
    side, wrist = takeback_side(kp, window["t0"], window["peak_t"])
    given = forehand_side in (1, -1)
    fs = forehand_side if given else forehand_side_of(window.get("heading"), hand, rules)
    whole = window.get("full_swing") is not False and \
        window.get("t1", window["peak_t"]) - window["peak_t"] >= float(rules["turn_follow_min_s"])
    turn = forward_turn(window.get("heading")) if whole else None  # without its follow-through a window's last turn
    #                                                                can be the takeback's
    by_side = stroke_of(side, fs, float(rules["margin"]))
    by_turn = stroke_by_turn(turn, hand, rules)
    if hand in HANDS:
        stroke = by_side if by_side is not None and by_side == by_turn else None
    else:
        stroke = by_side if given else None
    return {"side": side, "hitting_wrist": wrist, "forehand_side": fs,
            "forehand_side_from": "given" if given else "heading" if fs else None,
            "hand": hand, "turn": turn, "by_side": by_side, "by_turn": by_turn, "stroke": stroke}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kp", required=True)
    ap.add_argument("--desc", required=True)
    ap.add_argument("--window", type=int, required=True)
    ap.add_argument("--hand", choices=sorted(HANDS))
    ap.add_argument("--forehand-side", type=int, choices=[1, -1])
    ap.add_argument("--rules", help="a rules file in stroke-side.json's shape (default: stroke-side.json)")
    a = ap.parse_args()
    try:
        with open(a.kp) as f:
            kp = json.load(f)
        with open(a.desc) as f:
            window = json.load(f)["windows"][a.window]
        rules = rules_of()
        if a.rules:
            with open(a.rules) as f:
                rules = {**rules, **json.load(f)}
        print(json.dumps({"result": read_stroke(kp, window, a.hand, a.forehand_side, rules)}))
        return 0
    except Exception as e:  # one line the caller reads
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
