"""Pure readers for Whisper loops in a transcript made by the package's transcribe-audio.py: where one sentence repeats, and which
windows of the recording to hear again.

Nothing here runs a model or touches a file. A transcript is the package's result:
{"segments": [{"segment_index", "start", "end", "text"}], "words": [{"t", "start", "end", "timing_source"}], ...}.
"""
import re

SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
NON_WORD = re.compile(r"\W+")

# A segment is a loop when one sentence fills at least half of it and is said at least four times.
LOOP_MIN_SENTENCES, LOOP_MIN_REPEATS, LOOP_MIN_SHARE = 4, 4, 0.5
# Loop segments closer than MERGE_GAP seconds join into one window, padded by PAD seconds each side. A window is heard again
# when it holds at least MIN_REGION_SEGS loop segments or lasts at least MIN_REGION_SECS.
MERGE_GAP, PAD, MIN_REGION_SEGS, MIN_REGION_SECS = 15.0, 4.0, 4, 8.0


def looped(text):
    """True when one sentence is repeated through most of this text."""
    sentences = [s.strip().lower() for s in SENTENCE_END.split(text) if s.strip()]
    if len(sentences) < LOOP_MIN_SENTENCES:
        return False
    top = max(sentences.count(s) for s in set(sentences))
    return top >= LOOP_MIN_REPEATS and top / len(sentences) >= LOOP_MIN_SHARE


def loop_spans(doc):
    """(start, end) of every segment that is a loop or says exactly what the segment before it said."""
    spans, previous = [], None
    for segment in doc["segments"]:
        normal = NON_WORD.sub(" ", segment["text"].lower()).strip()
        if looped(segment["text"]) or (previous and normal == previous and len(normal) > 0):
            spans.append((segment["start"], segment["end"]))
        previous = normal
    return spans


def regions(doc, duration):
    """The windows (start, end) worth hearing again: nearby loop segments merged, padded, kept inside the recording."""
    out = []
    for start, end in sorted(loop_spans(doc)):
        if out and start - out[-1][1] <= MERGE_GAP:
            out[-1][1] = max(out[-1][1], end)
            out[-1][2] += 1
        else:
            out.append([start, end, 1])
    return [(max(0.0, s - PAD), min(duration, e + PAD)) for s, e, n in out if n >= MIN_REGION_SEGS or e - s >= MIN_REGION_SECS]


def shifted(heard, offset, digits=2):
    """The segments and words of one window heard again (the package's result for the window), moved to their place in the recording.

    A segment that still loops is left out, and so are the words that fall inside it.
    """
    def at(seconds):
        return round(seconds + offset, digits)

    segments = [{"start": at(s["start"]), "end": at(s["end"]), "text": s["text"]} for s in heard["segments"] if not looped(s["text"])]
    gone = [(s["start"], s["end"]) for s in heard["segments"] if looped(s["text"])]
    words = [dict(w, start=at(w["start"]), end=at(w["end"])) for w in heard["words"]
             if not any(a <= (w["start"] + w["end"]) / 2 <= b for a, b in gone)]
    return segments, words


def splice(doc, windows, redone):
    """doc with each window's segments and words replaced by what was heard again there (redone[i] = (segments, words)).

    Loops that survive elsewhere are taken out and kept in doc["removed_hallucinated"], so nothing disappears silently.
    Segments are numbered again and full_text is made again from them.
    """
    for (w0, w1), (segments, words) in zip(windows, redone):
        keep_segments = [s for s in doc["segments"] if not (w0 <= (s["start"] + s["end"]) / 2 <= w1)]
        keep_words = [w for w in doc["words"] if not (w0 <= (w["start"] + w["end"]) / 2 <= w1)]
        doc["segments"] = sorted(keep_segments + segments, key=lambda s: s["start"])
        doc["words"] = sorted(keep_words + words, key=lambda w: w["start"])
    removed = [s for s in doc["segments"] if looped(s["text"])]
    gone = {(s["start"], s["end"]) for s in removed}
    doc["segments"] = [s for s in doc["segments"] if (s["start"], s["end"]) not in gone]
    doc["words"] = [w for w in doc["words"] if not any(a <= w["start"] < b for a, b in gone)]
    for index, segment in enumerate(doc["segments"]):
        segment["segment_index"] = index
    doc["full_text"] = " ".join(s["text"] for s in doc["segments"]).strip()
    doc["removed_hallucinated"] = removed
    doc["repaired_windows"] = [[round(a, 2), round(b, 2)] for a, b in windows]
    return doc
