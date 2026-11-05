"""Pure readers over transcripts made by audio_transcription.py (the package's result shape): when a recording was made, a
one-line-per-recording index, whether Whisper's answer is to be trusted at all, and the transcript as timed paragraphs.

Nothing here runs a model. A transcript is {"segments": [{"start", "end", "text"}], "words": [{"t", "start", "end"}],
"duration", ...}; a word's text may also be under "w" or "text" (other Whisper front ends).
"""
import collections
import csv
import os
import re
import time

NON_WORD = re.compile(r"\W+")
CREATION_DATE = re.compile(r'<CreationDate value="([^"]+)"')

# A whole answer is rejected (looping or invented on silence or noise) when any of these holds:
# one segment's text is a quarter or more of all segments and said at least SEGMENT_REPEAT_MIN times;
# one run of four words comes back at least max(NGRAM_REPEAT_MIN, minutes * NGRAM_REPEAT_PER_MINUTE) times;
# under UNIQUE_WORD_RATIO_MIN of the words are different words (with more than UNIQUE_WORD_MIN_WORDS words);
# fewer than WORDS_PER_MINUTE_MIN words a minute; more than half the segments carry a no-speech probability over NO_SPEECH_PROB.
SEGMENT_REPEAT_MIN, SEGMENT_REPEAT_SHARE = 3, 0.25
NGRAM, NGRAM_REPEAT_MIN, NGRAM_REPEAT_PER_MINUTE = 4, 6, 0.5
UNIQUE_WORD_RATIO_MIN, UNIQUE_WORD_MIN_WORDS = 0.18, 40
WORDS_PER_MINUTE_MIN = 30
NO_SPEECH_PROB, NO_SPEECH_SHARE = 0.6, 0.5


def word_text(word):
    return str(word.get("t", word.get("w", word.get("text", ""))))


def recorded_at(recording):
    """When a recording was made: a camera's sidecar XML beside it (<stem>M01.XML or <stem>.XML, its CreationDate), else the
    file's modified time in local time. Returns (when, where it was read from)."""
    stem = os.path.splitext(recording)[0]
    for sidecar in (stem + "M01.XML", stem + ".XML", stem + ".xml"):
        if os.path.exists(sidecar):
            with open(sidecar, encoding="utf-8", errors="replace") as handle:
                found = CREATION_DATE.search(handle.read())
            if found:
                return found.group(1), "sidecar:" + os.path.basename(sidecar)
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(os.path.getmtime(recording))), "file-modified-time"


def index_row(name, doc, first_line_chars=120):
    """One recording's line: its name, length, how many words and segments, and the first thing said."""
    first = doc["segments"][0]["text"] if doc["segments"] else ""
    return {"name": name, "duration": float(doc.get("duration") or 0.0), "words": len(doc["words"]),
            "segments": len(doc["segments"]), "first_line": " ".join(first.split())[:first_line_chars]}


def index_tsv(rows):
    lines = ["name\tduration\twords\tsegments\tfirst_line"]
    lines += [f"{r['name']}\t{r['duration']:.1f}\t{r['words']}\t{r['segments']}\t{r['first_line']}" for r in rows]
    return "\n".join(lines) + "\n"


def index_totals(rows):
    return {"recordings": len(rows), "hours": round(sum(r["duration"] for r in rows) / 3600, 2),
            "silent": sum(1 for r in rows if r["words"] == 0), "segments": sum(r["segments"] for r in rows),
            "words": sum(r["words"] for r in rows)}


def durations_list(path, id_column="id", duration_column="duration"):
    """Each recording's length in seconds from a tab-separated list with a header: {name: seconds}, for the rows that give one.
    A transcript's name is its file name up to the first dot."""
    with open(path, encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle, delimiter="\t"))
    return {r[id_column]: float(r[duration_column]) for r in rows if (r.get(duration_column) or "").strip()}


def judge(doc, duration=None):
    """Why this whole answer looks like Whisper looping or inventing speech, as a list of reasons; empty when it can be trusted."""
    segments, words = doc["segments"], doc["words"]
    duration = float(duration or doc.get("duration") or 0.0)
    if not words:
        return ["no words"]
    reasons = []
    texts = [NON_WORD.sub(" ", s["text"].lower()).strip() for s in segments]
    said = collections.Counter(t for t in texts if t)
    if said:
        text, times = said.most_common(1)[0]
        if times >= SEGMENT_REPEAT_MIN and times / max(1, len(texts)) >= SEGMENT_REPEAT_SHARE:
            reasons.append(f"segment repeated {times}x of {len(texts)}")
    spoken = [word_text(w).lower() for w in words]
    runs = collections.Counter(tuple(spoken[i:i + NGRAM]) for i in range(len(spoken) - NGRAM + 1))
    minutes = duration / 60 if duration else 0.0
    if runs:
        run, times = runs.most_common(1)[0]
        if times >= max(NGRAM_REPEAT_MIN, minutes * NGRAM_REPEAT_PER_MINUTE):
            reasons.append(f"{NGRAM}-gram {' '.join(run)!r} x{times}")
    if len(spoken) > UNIQUE_WORD_MIN_WORDS and len(set(spoken)) / len(spoken) < UNIQUE_WORD_RATIO_MIN:
        reasons.append("unique-word ratio %.2f" % (len(set(spoken)) / len(spoken)))
    if minutes and len(spoken) / minutes < WORDS_PER_MINUTE_MIN:
        reasons.append("words per minute %.0f" % (len(spoken) / minutes))
    quiet = sum(1 for s in segments if (s.get("no_speech_prob") or 0) > NO_SPEECH_PROB)
    if segments and quiet / len(segments) > NO_SPEECH_SHARE:
        reasons.append(f"no_speech_prob>{NO_SPEECH_PROB} in {quiet}/{len(segments)} segments")
    return reasons


def stamp(seconds):
    """[m:ss] or, past an hour, [h:mm:ss]."""
    s = int(seconds)
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"[{h}:{m:02d}:{sec:02d}]" if h else f"[{m}:{sec:02d}]"


def paragraphs(doc, every=30.0):
    """The segments gathered into paragraphs: a new paragraph starts at the first segment `every` seconds or more after the
    current paragraph began. Returns [(start, text)]."""
    out, current = [], None
    for segment in doc["segments"]:
        if current is None or segment["start"] - current[0] >= every:
            current = [segment["start"], []]
            out.append(current)
        current[1].append(segment["text"].strip())
    return [(start, re.sub(r"\s+", " ", " ".join(texts)).strip()) for start, texts in out]


def as_text(doc, title, every=30.0, header=()):
    """The transcript as a text file: '# title', any header lines, a blank line, then one '[m:ss] paragraph' per line."""
    lines = [f"# {title}", *header, ""]
    lines += [f"{stamp(start)} {text}" for start, text in paragraphs(doc, every)]
    return "\n".join(lines) + "\n"
