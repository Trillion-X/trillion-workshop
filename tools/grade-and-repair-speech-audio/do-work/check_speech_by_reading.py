"""Whisper-read every audio file grades.json points at and count word errors.

  check_speech_by_reading.py --settings settings.json --out DIR

The files carry HANDLE seconds either side; the read covers only the part between them. Two counts per span, each a
word-level edit distance (reading.py):
  vs_original   the output read against a read of the untouched cut (same decoder, so only the audio differs).
  vs_transcript the output read against the span's text.
The bar for as-is and remastered spans is zero on either count (a quiet original can misread where the remaster
reads right; the transcript can differ from the audio where the original read already agrees with the output).
The bar for cloned spans, which speak the text, is zero vs_transcript. Results go to DIR/work/verify.json.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "read-data"))

import grade_and_repair_speech as grader  # noqa: E402
import reading  # noqa: E402
import settings as settings_file  # noqa: E402


def passes(v):
    if "error" in v:
        return False
    if v["cloned"]:
        return v["vs_transcript"] == 0
    return v["vs_original"] == 0 or v["vs_transcript"] == 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="the folder grade_and_repair_speech.py wrote")
    ap.add_argument("--settings", required=True, help="the person's settings file, the one the grade was made with")
    a = ap.parse_args()
    t = settings_file.load(a.settings)
    work = grader.work_dir(a.out)
    state = json.load(open(grader.state_path(a.out)))
    results = {}
    for sid, g in json.load(open(os.path.join(a.out, "grades.json")))["spans"].items():
        if "audio" not in g:
            results[sid] = {"error": "no audio file: grade is clone and no take passed"}
            continue
        text = state[sid]["text"]
        heard = reading.cached_read(os.path.join(a.out, g["audio"]), t, work)
        original = None if g["cloned"] else reading.cached_read(os.path.join(work, "raw", f"{sid}.wav"), t, work)
        results[sid] = {
            "treatment": g["treatment"], "cloned": g["cloned"], "words": len(reading.norm(text, t["spoken_forms"])),
            "vs_original": None if original is None else reading.errors(original, heard, t["spoken_forms"]),
            "vs_transcript": reading.errors(text, heard, t["spoken_forms"]),
            "heard": heard, "original_read": original, "transcript": text,
        }
        v = results[sid]
        print(sid, g["treatment"], "vs_original", v["vs_original"], "vs_transcript", v["vs_transcript"],
              "PASS" if passes(v) else "FAIL", flush=True)
    json.dump(results, open(os.path.join(work, "verify.json"), "w"), indent=1)
    bad = [k for k, v in results.items() if not passes(v)]
    print(f"{len(results)} files, {len(bad)} failing the bar:", *bad, sep="\n  ")
    print(json.dumps({"result": {"verify": os.path.join(work, "verify.json"), "files": len(results), "failing": bad}}))
