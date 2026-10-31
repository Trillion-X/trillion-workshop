"""Read the spans to grade: one JSON file, each span a stretch of one recording with the words said in it.

A JSON object with a `spans` list. Each span has `clip`, `source`, `from`, `to`, `text` and, optionally, `words`
(a list of `text`, `start`, `end`).

`clip` names the recording, `source` is its media file (only ever read), `from` and `to` are source seconds, `text`
is what is said in the span. `words` (optional) are the words with times in source seconds: with them the noise floor
is read from the pauses between words and a room tail can be found; without them the quietest fifth of the span's frames
stands in for the pauses, no room tail is measured, a remaster cannot duck the pauses, and a clone cannot time its phrases.
The span id is clip_from_to, the same for the same cut wherever it is listed, so a repeated cut is graded once.
"""
import json
import os

REQUIRED = ("clip", "source", "from", "to", "text")


def span_id(s):
    return f"{s['clip']}_{s['from']:.2f}_{s['to']:.2f}"


def graded_audio_name(sid):
    """The graded file of span sid, relative to the output folder. One name, so the writer and any reader cannot disagree."""
    return f"audio/{sid}.wav"


def load_spans(path):
    """The spans of one spans file, a repeated cut once, in file order. Refuses a span that lacks a field or ends before it starts."""
    kept = {}
    for i, s in enumerate(json.load(open(path))["spans"]):
        missing = [k for k in REQUIRED if k not in s]
        if missing:
            raise SystemExit(f"{path}: span {i} lacks {', '.join(missing)}")
        if not s["to"] > s["from"] >= 0:
            raise SystemExit(f"{path}: span {i} ({s['clip']}) ends at {s['to']}, before it starts at {s['from']}")
        if not os.path.exists(s["source"]):
            raise SystemExit(f"{path}: span {i} ({s['clip']}): {s['source']} is not a file")
        kept.setdefault(span_id(s), s)
    return kept


def span_words(words, s):
    """Words inside the span, times relative to the span start."""
    if not words:
        return []
    return [
        {"text": w["text"], "start": round(w["start"] - s["from"], 3), "end": round(w["end"] - s["from"], 3)}
        for w in words if w["start"] >= s["from"] - 0.02 and w["end"] <= s["to"] + 0.05
    ]
