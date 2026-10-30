#!/usr/bin/env python3
"""Stands in for whisper.cpp's whisper-cli in tests: takes its arguments, writes the JSON it would, without a model.

A first listen returns a looped stretch (one sentence said five times) between two ordinary segments. A listen with the context off
(-mc 0) returns the true words of its window plus one segment that still loops. Each call is appended to $FAKE_WHISPER_LOG.
"""
import json
import os
import sys

argv = sys.argv[1:]
value = lambda flag: argv[argv.index(flag) + 1]
base = value("-of")
again = "-mc" in argv and value("-mc") == "0"
with open(os.environ["FAKE_WHISPER_LOG"], "a") as log:
    log.write(json.dumps({"again": again, "model": value("-m"), "wav": os.path.basename(value("-f"))}) + "\n")


def segment(start, end, text):
    return {"timestamps": {"from": "00:00:00,000", "to": "00:00:00,000"}, "offsets": {"from": int(start * 1000), "to": int(end * 1000)}, "text": " " + text}


LOOP = " ".join(["Thanks for watching."] * 5)
segments = ([segment(0.0, 2.0, "this is what was really said"), segment(2.0, 6.0, LOOP)] if again
            else [segment(0.0, 3.0, "hello there everyone"), segment(20.0, 36.0, LOOP), segment(50.0, 55.0, "goodbye for now")])
with open(base + ".json", "w") as handle:
    json.dump({"result": {"language": "en"}, "transcription": segments}, handle)
