"""Find each stroke in a pose track: its contact second and its window from ready to finish.

USAGE: find_strokes.py --track TRACK.json --out STROKES.json [--min-speed 0.33] [--min-arc 0.65]

Uses describe_clip.detect_windows (perception/) with its three physical rules switched on as data (Nov 20 2026, on
real Aug 28 and Sep 10 footage; the rules live in describe_clip.SalienceConfig, off by default there):
1. lost_body_frac 0.4: a frame where the body is lost (its height under 0.4 of the median) cannot move a wrist; the
   tracker jumping between people there read as 50-95 body heights a frame and hid every real swing behind it.
2. max_body_heights_per_frame 1.0: a wrist cannot move more than one body height in one frame; faster is a glitch.
3. cap_percentile 0.99: one freak moment (someone walking past the lens) cannot set the bar for a ten-minute clip
   (15 strokes found in 9.6 minutes before, 112 windows after).
--salience-config JSON overrides any of them (or any other SalienceConfig field).
A window is a stroke only when the hitting wrist both peaks at >= min_speed body heights a frame and sweeps
>= min_arc body heights across the hips (walking and racket bouncing between points fail it).
Contact is the frame of the fastest wrist in the window.
Last line: {"result": {...}} or {"error": "..."}.
"""
import argparse, json, os, statistics, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "process-scripts", "perception"))
import describe_clip as dc  # noqa: E402

RULES = {"lost_body_frac": 0.4, "max_body_heights_per_frame": 1.0, "cap_percentile": 0.99}


def wrist_speeds(fr, bh):
    return [0.0] + [max(abs(fr[i]["kp"][j][0] - fr[i - 1]["kp"][j][0]) + abs(fr[i]["kp"][j][1] - fr[i - 1]["kp"][j][1])
                        for j in (9, 10)) / bh for i in range(1, len(fr))]


def strokes(track, min_speed, min_arc, salience=None):
    cfg = dc.salience_config_from_dict({**RULES, **(salience or {})})
    person = dc.main_track(track)
    fps = track["video"]["fps"]
    found = []
    for a, b in dc.detect_windows(person, fps, cfg):
        fr = person["frames"][a:b + 1]
        if len(fr) < 4:
            continue
        bh = statistics.median(dc.body_h_at(f["kp"]) for f in fr) or 1.0
        arc = 0.0
        for j in (9, 10):
            rel = [(f["kp"][j][0] - (f["kp"][11][0] + f["kp"][12][0]) / 2) / bh for f in fr if f["kp"][j][2] > 0.3]
            if len(rel) >= 4:
                arc = max(arc, max(rel) - min(rel))
        sp = wrist_speeds(fr, bh)
        if max(sp) < min_speed or arc < min_arc:
            continue
        found.append({"contact_s": round(fr[sp.index(max(sp))]["t"], 3), "window_s": [fr[0]["t"], fr[-1]["t"]],
                      "peak_speed": round(max(sp), 3), "arc": round(arc, 3)})
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-speed", type=float, default=0.33)
    ap.add_argument("--min-arc", type=float, default=0.65)
    ap.add_argument("--salience-config", default=None, help="JSON object of SalienceConfig fields to override")
    a = ap.parse_args()
    track = json.load(open(a.track))
    found = strokes(track, a.min_speed, a.min_arc, json.loads(a.salience_config) if a.salience_config else None)
    json.dump({"video": track["video"], "strokes": found}, open(a.out, "w"), indent=1)
    print(json.dumps({"result": {"out": a.out, "strokes": len(found)}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
