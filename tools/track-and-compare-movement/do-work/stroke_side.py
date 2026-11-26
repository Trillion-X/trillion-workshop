#!/usr/bin/env python3
"""Which side of the body a swing's takeback goes to ON SCREEN, and from that, with the recording's forehand side,
whether a swing is a forehand or a backhand.

Why: a comparison must pair the same stroke. Pose distance between two different people cannot tell a forehand from
a backhand reliably (measured Nov 25 2026: a student's two-handed backhands sat closer to a pro's forehands than to
his one-handed backhands), and a pose model seen from behind can swap the body's left and right labels, so this reads
nothing by its left/right name. It reads image space only:
  hitting wrist   the wrist that moves furthest over the last frames before contact (whichever label it carries)
  takeback side   from the window's start to contact, the hitting wrist's horizontal offset from the hips' middle,
                  in body widths; the extreme with the larger size, signed (+ = screen right)
A recording's forehand side (+1: forehand takebacks go to screen right; -1: to screen left) is a fact about how that
recording was filmed (where the camera stood, whether the picture is mirrored, which hand the player uses). It is
DATA given per recording or per library, never guessed here.
  stroke = forehand when side x forehand_side >= margin, backhand when <= -margin, otherwise unclear (refused).
Measured with margin 2 on 59 labelled one-swing pro clips and 5 labelled student backhands: 0 called wrong.

USAGE: stroke_side.py --kp POSE.json --t0 S --contact S [--forehand-side 1|-1] [--margin 2]
Last line: {"result": {"side", "hitting_wrist", "stroke"}} or {"error": ...}.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "process-scripts", "perception"))
from pose_schema import JI  # noqa: E402
from describe_clip import main_track  # noqa: E402  the same player the swing windows were found on

MIN_CONFIDENCE = 0.3
LAST_FRAMES = 6


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


def stroke_of(side, forehand_side, margin=2.0):
    if side is None or forehand_side not in (1, -1):
        return None
    signed = side * forehand_side
    return "forehand" if signed >= margin else "backhand" if signed <= -margin else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kp", required=True)
    ap.add_argument("--t0", type=float, required=True)
    ap.add_argument("--contact", type=float, required=True)
    ap.add_argument("--forehand-side", type=int, choices=[1, -1])
    ap.add_argument("--margin", type=float, default=2.0)
    a = ap.parse_args()
    try:
        with open(a.kp) as f:
            side, wrist = takeback_side(json.load(f), a.t0, a.contact)
        print(json.dumps({"result": {"side": side, "hitting_wrist": wrist,
                                     "stroke": stroke_of(side, a.forehand_side, a.margin) if a.forehand_side else None}}))
        return 0
    except Exception as e:  # one line the caller reads
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
