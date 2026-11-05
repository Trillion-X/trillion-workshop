#!/usr/bin/env python3
"""Print segments of a clip between two seconds: show_segments.py CLIP START END."""
# CLIP is the path of the clip's words.json (any transcript with segments [{start, text}]). Each segment whose start lies
# between START and END seconds is printed as its rounded start and its first 140 characters; the last line printed is
# {"result": {"segments": [{"start", "text"}]}}.
import json, sys
if len(sys.argv) != 4:
    raise SystemExit("usage: show_segments.py CLIP.words.json START END (seconds)")
with open(sys.argv[1], encoding="utf-8") as handle:
    d = json.load(handle)
shown = []
for s in d["segments"]:
    if float(sys.argv[2]) <= s["start"] <= float(sys.argv[3]):
        print(round(s["start"]), s["text"][:140])
        shown.append({"start": s["start"], "text": s["text"]})
print(json.dumps({"result": {"segments": shown}}, ensure_ascii=False))
