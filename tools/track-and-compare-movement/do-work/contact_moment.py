"""The real contact moment of one swing: the sharp sound of the ball being struck, near the fastest wrist moment.

USAGE: contact_moment.py --clip CLIP.mp4 --t0 S --t1 S --wrist-peak S --media-composition DIR [--tolerance 0.25] [--audio-lag 0]

The fastest wrist moment (describe_clip's peak_t) is only where the arm is quickest; the ball is struck a little before
or after it. media-composition's do-work/find-action-moments.mjs finds a hit from a sharp sound (led by motion). This
reads its moments for [t0, t1] and takes the strongest SOUND moment within `tolerance_s` of the wrist peak.
The sound reaches the recording a steady time after the ball is struck (`audio_lag_s`, a fact of the kind of recording,
given as DATA); the contact is the sound's time minus it. Measured Nov 28 2026 against 11 contacts a person marked
frame by frame: the strongest sharp sound within 0.6 s of the fastest wrist was the hit every time; it came 0.027 to
0.077 s (mean 0.05) after contact on a phone recording and 0.066 to 0.116 s (mean 0.09) on a broadcast, while the
fastest wrist ran from 0.42 s before contact to 0.07 s after (no steady offset).
No guess: with no audio (that finder then ranks motion alone and reports sound 0), no sharp sound near the wrist peak,
or a finder failure, the answer is the wrist peak itself with source "wrist" and the reason. Every time stays inside
[t0, t1].
DIR is media-composition's tool folder (or its do-work folder).
Last line: {"result": {"time", "source": "hit"|"wrist", "hit": {...}|null, "why"}} or {"error": "..."}.
"""
import argparse, json, os, subprocess, sys

FINDER = "find-action-moments.mjs"
MIN_GAP_S = 0.05
COUNT = 50


def finder_path(media_composition_dir):
    for folder in (os.path.join(media_composition_dir, "do-work"), media_composition_dir):
        path = os.path.join(folder, FINDER)
        if os.path.isfile(path):
            return path
    raise FileNotFoundError(f"{FINDER} is not in {media_composition_dir}")


def moments_between(clip_path, t0, t1, finder):
    ran = subprocess.run(["node", finder, clip_path, "--from", str(t0), "--to", str(t1),
                          "--count", str(COUNT), "--min-gap", str(MIN_GAP_S)],
                         capture_output=True, text=True, check=False)
    if ran.returncode != 0:
        raise RuntimeError((ran.stderr or "the finder failed").strip().splitlines()[-1])
    return json.loads(ran.stdout.strip().splitlines()[-1])["moments"]


def contact(clip_path, t0, t1, wrist_peak, media_composition_dir, tolerance_s=0.25, audio_lag_s=0.0):
    if not (t1 > t0):
        raise ValueError(f"the window must end after it starts; it was {t0} to {t1}")
    fallback = min(max(float(wrist_peak), float(t0)), float(t1))

    def wrist(why):
        return {"time": fallback, "source": "wrist", "hit": None, "why": why}

    finder = finder_path(media_composition_dir)  # a missing finder is a set-up fault, not a clip without a hit
    try:
        moments = moments_between(clip_path, t0, t1, finder)
    except (RuntimeError, ValueError, KeyError) as err:
        return wrist(f"the hit finder could not read the clip ({err}); the wrist peak stands")
    sounds = [m for m in moments if m.get("sound", 0) > 0 and t0 <= m["time"] <= t1]
    if not sounds:
        return wrist("no sharp sound in the window (no audio, or nothing but silence); the wrist peak stands")
    near = [m for m in sounds if abs(m["time"] - wrist_peak) <= tolerance_s]
    if not near:
        gap = min(abs(m["time"] - wrist_peak) for m in sounds)
        return wrist(f"the nearest sharp sound is {gap:.2f} s from the wrist peak, outside the {tolerance_s} s tolerance")
    best = max(near, key=lambda m: m["strength"])
    at = min(max(best["time"] - float(audio_lag_s), float(t0)), float(t1))
    return {"time": round(at, 6), "source": "hit", "hit": best,
            "why": f"strongest sharp sound within {tolerance_s} s of the wrist peak, {best['time'] - wrist_peak:+.3f} s from it, "
                   f"less the recording's audio lag {float(audio_lag_s)} s"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", required=True)
    ap.add_argument("--t0", type=float, required=True)
    ap.add_argument("--t1", type=float, required=True)
    ap.add_argument("--wrist-peak", type=float, required=True)
    ap.add_argument("--media-composition", required=True)
    ap.add_argument("--tolerance", type=float, default=0.25)
    ap.add_argument("--audio-lag", type=float, default=0.0, help="seconds the hit sound arrives after contact in this recording")
    a = ap.parse_args()
    try:
        out = contact(a.clip, a.t0, a.t1, a.wrist_peak, a.media_composition, a.tolerance, a.audio_lag)
    except (ValueError, FileNotFoundError) as err:
        print(json.dumps({"error": str(err)}))
        return 1
    print(json.dumps({"result": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
