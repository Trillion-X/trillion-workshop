"""Find each stroke in a pose track: its contact second and its window from ready to finish.

USAGE: find_strokes.py --track TRACK.json --out STROKES.json [--min-speed 0.33] [--min-arc 0.65]

Uses describe_clip.detect_windows (perception/) and adds three physical rules it lacks (Nov 20 2026, on real
Aug 28 and Sep 10 footage):
1. A frame where the body is lost (its height under 0.4 of the median) cannot move a wrist; the tracker jumping
   between people there read as 50-95 body heights a frame and hid every real swing behind it.
2. A wrist cannot move more than one body height in one frame; faster is a tracker glitch, set to 0.
3. The signal is capped at its 99th percentile, so one freak moment (someone walking past the lens) cannot set the
   bar for a ten-minute clip (15 strokes found in 9.6 minutes before, 112 windows after).
A window is a stroke only when the hitting wrist both peaks at >= min_speed body heights a frame and sweeps
>= min_arc body heights across the hips (walking and racket bouncing between points fail it).
Contact is the frame of the fastest wrist in the window.
Last line: {"result": {...}} or {"error": "..."}.
"""
import argparse, json, os, statistics, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "process-scripts", "perception"))
import describe_clip as dc  # noqa: E402

_raw_salience = dc.salience_series


def physical_salience(person, cfg=dc.DEFAULT_SALIENCE_CONFIG):
    s = _raw_salience(person, cfg)
    fr = person["frames"]
    heights = [dc.body_h_at(f["kp"]) for f in fr]
    med = statistics.median(heights) if heights else 0
    lost = [h < 0.4 * med for h in heights]
    out = [0.0 if (any(lost[max(0, k - 6):k + 7]) or v > 1.0) else v for k, v in enumerate(s)]
    if out:
        cap = sorted(out)[int(0.99 * (len(out) - 1))]
        out = [min(v, cap) for v in out]
    return out


def wrist_speeds(fr, bh):
    return [0.0] + [max(abs(fr[i]["kp"][j][0] - fr[i - 1]["kp"][j][0]) + abs(fr[i]["kp"][j][1] - fr[i - 1]["kp"][j][1])
                        for j in (9, 10)) / bh for i in range(1, len(fr))]


def strokes(track, min_speed, min_arc):
    dc.salience_series = physical_salience
    person = dc.main_track(track)
    fps = track["video"]["fps"]
    found = []
    for a, b in dc.detect_windows(person, fps):
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
    a = ap.parse_args()
    track = json.load(open(a.track))
    found = strokes(track, a.min_speed, a.min_arc)
    json.dump({"video": track["video"], "strokes": found}, open(a.out, "w"), indent=1)
    print(json.dumps({"result": {"out": a.out, "strokes": len(found)}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
