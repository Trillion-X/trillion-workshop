"""Measure the speech in a list of spans, and nothing else: no grade, no remaster, no settings.

  probe_speech.py --spans spans.json --out DIR

Each unique span (see read-data/spans.py) is cut exactly from `from` to `to` into DIR/<span id>.wav (16-bit, the source's
channels) and measured by read-data/measure.py: loudness, true peak, noise floor (from the pauses between words when the
span has word times), SNR, clipping, mains hum, wind rumble and room tail. Prints one line per span as it goes and writes
DIR/probe.json ({span id: measures and n_words}). Use it to see what a set of recordings is like before choosing the
settings the grade is judged against; show_probe.py prints probe.json one line per span. Source recordings are only read.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "read-data"))

import measure  # noqa: E402
import spans as spans_file  # noqa: E402


def probe(spans_path, out):
    os.makedirs(out, exist_ok=True)
    result = {}
    for sid, s in spans_file.load_spans(spans_path).items():
        wav = os.path.join(out, f"{sid}.wav")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(s["from"]), "-t", str(s["to"] - s["from"]),
                        "-i", s["source"], "-vn", "-c:a", "pcm_s16le", wav], check=True)
        words = spans_file.span_words(s.get("words"), s)
        result[sid] = measure.measure(wav, words) | {"n_words": len(words)}
        print(sid, json.dumps(result[sid]), flush=True)
    path = os.path.join(out, "probe.json")
    with open(path, "w") as f:
        json.dump(result, f, indent=1)
    return path, result


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--spans", required=True, help="the spans file (see read-data/spans.py)")
    ap.add_argument("--out", required=True, help="the folder to write the cuts and probe.json into")
    a = ap.parse_args()
    path, result = probe(a.spans, a.out)
    print(json.dumps({"result": {"probe": path, "spans": len(result)}}))
