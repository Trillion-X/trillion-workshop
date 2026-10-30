"""Writes the synthetic inputs the tests use: WORK/transcripts/<name>.words.json (five segments, four moments) and WORK/moments.jsonl."""
import json
import os
import sys

work = sys.argv[1]
os.makedirs(os.path.join(work, "transcripts"), exist_ok=True)
segments = [(0, 3, "I save money every week."), (3.5, 6, "Money makes everything easier."), (16, 19, "A forgotten idea about gardens."),
            (40, 43, "Gardens need patience."), (60, 62, "um uh okay")]
doc = {"source": "take.wav", "timing": "word", "duration": 70.0, "words": [],
       "segments": [{"text": t, "start": s, "end": e} for s, e, t in segments]}
with open(os.path.join(work, "transcripts", "take.words.json"), "w") as handle:
    json.dump(doc, handle)
with open(os.path.join(work, "transcripts", "words-only.words.json"), "w") as handle:
    json.dump({"source": "x.wav", "timing": "word", "words": []}, handle)
with open(os.path.join(work, "moments.jsonl"), "w") as handle:
    for i, text in enumerate(["Money is a tool.", "Gardens need patience.", "um uh okay"]):
        handle.write(json.dumps({"id": f"m{i}", "text": text, "where": f"file-{i}"}) + "\n")
