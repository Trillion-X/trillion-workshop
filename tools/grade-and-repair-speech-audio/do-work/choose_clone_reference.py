"""Pick the cleanest stretch of continuous speech in a person's own recordings as the clone reference.

  choose_clone_reference.py --recordings recordings.json --settings settings.json --out DIR [--window 10] [--top 5]

recordings.json: a JSON object with a `recordings` list; each recording has `clip`, `source` and `words` (a list of
`text`, `start`, `end`; word times in source seconds). List only recordings of the person who agreed to be cloned. A window is the first run
of words in a recording with no gap over 0.4 s that lasts the window length. Each is cut to a wav (the source is only
read), measured with measure.py and ranked by SNR among those inside the settings' reference loudness window. DIR/reference-candidates.json lists them.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "read-data"))

import measure  # noqa: E402
import settings as settings_file  # noqa: E402


def windows(words, length):
    run = []
    for w in words:
        if run and w["start"] - run[-1]["end"] > 0.4:
            run = []
        run.append(w)
        if run[-1]["end"] - run[0]["start"] >= length:
            yield run
            run = []


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--recordings", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--settings", required=True, help="the person's settings file (reference_lufs_min and reference_lufs_max are read)")
    ap.add_argument("--window", type=float, default=10)
    ap.add_argument("--top", type=int, default=5)
    a = ap.parse_args()
    t = settings_file.load(a.settings)
    os.makedirs(a.out, exist_ok=True)
    rows = []
    for rec in json.load(open(a.recordings))["recordings"]:
        if not rec.get("words"):
            continue
        for run in windows(rec["words"], a.window):
            start, end = run[0]["start"], run[-1]["end"]
            wav = os.path.join(a.out, f"{rec['clip']}_{start:.2f}.wav")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start), "-t", str(end - start), "-i", rec["source"],
                            "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s24le", wav], check=True)
            ws = [{"text": w["text"], "start": w["start"] - start, "end": w["end"] - start} for w in run]
            m = measure.measure(wav, ws)
            rows.append({"wav": wav, "clip": rec["clip"], "from": start, "to": end,
                         "text": " ".join(w["text"] for w in run), **m})
            break
    rows = [r for r in rows if t["reference_lufs_min"] <= r["lufs"] <= t["reference_lufs_max"] and r["clip_fraction"] == 0]
    rows.sort(key=lambda r: -r["snr_db"])
    path = os.path.join(a.out, "reference-candidates.json")
    json.dump(rows, open(path, "w"), indent=1)
    for r in rows[: a.top]:
        print(r["wav"], "snr", r["snr_db"], "lufs", r["lufs"], "tail", r["room_tail_db"], "|", r["text"][:90])
    print(json.dumps({"result": {"candidates": path, "best": [r["wav"] for r in rows[: a.top]]}}))
