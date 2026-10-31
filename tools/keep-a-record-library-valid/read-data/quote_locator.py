"""Read-only literal quote locator for transcript text and original JSON3 captions.

This reports where a normalized, ordered word sequence occurs in each supplied
source. It does not interpret the quote or establish what was spoken or seen.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any


_WORD = re.compile(r"[a-z0-9]+")


def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _one_match(words: list[str], wanted: list[str], source: str) -> tuple[int, int]:
    if not wanted:
        raise ValueError("quote must contain at least one letter or digit")
    hits = [i for i in range(len(words) - len(wanted) + 1)
            if words[i:i + len(wanted)] == wanted]
    if len(hits) != 1:
        raise ValueError(f"quote must match exactly once in {source}; found {len(hits)}")
    return hits[0], hits[0] + len(wanted) - 1


def _read_transcript(path: Path) -> tuple[list[str], list[int]]:
    try:
        text = path.read_bytes().decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("transcript must be valid UTF-8") from exc
    # LF is the physical line delimiter. A terminal LF creates no extra line.
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    words: list[str] = []
    owners: list[int] = []
    for line_number, line in enumerate(lines, 1):
        # Match the existing transcript convention: an optional [caption time]
        # prefix is metadata, never a physical line number.
        line = re.sub(r"^\[[^]]*\]\s*", "", line, count=1)
        line_words = _words(line)
        words.extend(line_words)
        owners.extend([line_number] * len(line_words))
    return words, owners


def _json3_events(path: Path) -> list[dict[str, Any]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("JSON3 source must be valid UTF-8 JSON") from exc
    if not isinstance(value, dict) or not isinstance(value.get("events"), list):
        raise ValueError("JSON3 source must contain an events array")
    events = value["events"]
    for i, event in enumerate(events):
        if not isinstance(event, dict):
            raise ValueError(f"JSON3 event {i} must be an object")
        segs = event.get("segs", [])
        if not isinstance(segs, list):
            raise ValueError(f"JSON3 event {i} segs must be an array")
        for j, seg in enumerate(segs):
            if not isinstance(seg, dict) or not isinstance(seg.get("utf8", ""), str):
                raise ValueError(f"JSON3 event {i} segment {j} utf8 must be text")
    return events


def _milliseconds(event: dict[str, Any], field: str, event_index: int) -> float:
    value = event.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"matching JSON3 event {event_index} requires numeric {field}")
    try:
        number = float(value)
    except OverflowError as exc:
        raise ValueError(f"matching JSON3 event {event_index} requires finite {field}") from exc
    if not math.isfinite(number):
        raise ValueError(f"matching JSON3 event {event_index} requires finite {field}")
    return number


def locate_quote(transcript_path: str | Path, json3_path: str | Path, quote: str) -> dict[str, Any]:
    """Locate a literal quote in transcript and JSON3 sources.

    Each quote must have at least one normalized word and occur exactly once in
    both sources. Timing is required only for the caption events owning the
    first and last matched words. The first event needs ``tStartMs``; the last
    needs ``tStartMs`` and ``dDurationMs``. Zero is valid, booleans and
    non-finite values are not. A negative duration is rejected.
    """
    if not isinstance(quote, str):
        raise TypeError("quote must be text")
    if not isinstance(transcript_path, (str, Path)) or not isinstance(json3_path, (str, Path)):
        raise TypeError("source paths must be strings or pathlib Paths")
    wanted = _words(quote)
    if not wanted:
        raise ValueError("quote must contain at least one letter or digit")

    transcript_words, line_owners = _read_transcript(Path(transcript_path))
    first_word, last_word = _one_match(transcript_words, wanted, "transcript")
    physical_lines = [line_owners[first_word], line_owners[last_word]]

    events = _json3_events(Path(json3_path))
    caption_words: list[str] = []
    event_owners: list[int] = []
    for event_index, event in enumerate(events):
        text = " ".join(seg.get("utf8", "") for seg in event.get("segs", []))
        tokens = _words(text)
        caption_words.extend(tokens)
        event_owners.extend([event_index] * len(tokens))
    first_caption_word, last_caption_word = _one_match(caption_words, wanted, "JSON3 source")
    first_event_index = event_owners[first_caption_word]
    last_event_index = event_owners[last_caption_word]
    first_event = events[first_event_index]
    last_event = events[last_event_index]
    start_ms = _milliseconds(first_event, "tStartMs", first_event_index)
    end_start_ms = _milliseconds(last_event, "tStartMs", last_event_index)
    duration_ms = _milliseconds(last_event, "dDurationMs", last_event_index)
    if start_ms < 0 or end_start_ms < 0:
        raise ValueError("matching JSON3 event caption start times must be nonnegative")
    if duration_ms < 0:
        raise ValueError(f"matching JSON3 event {last_event_index} dDurationMs must be nonnegative")
    end_ms = end_start_ms + duration_ms
    if not math.isfinite(end_ms):
        raise ValueError(f"matching JSON3 event {last_event_index} exposure endpoint must be finite")
    if end_ms < start_ms:
        raise ValueError("matching JSON3 caption exposure endpoint must not precede its start")

    return {
        "physical_lf_lines": physical_lines,
        "caption_exposure_seconds": [start_ms / 1000, end_ms / 1000],
        "json3_event_indices": [first_event_index, last_event_index],
        "normalized_ordered_match": True,
        "token_count": len(wanted),
        "limits": "Literal quote location and caption exposure only; no meaning, speaker identity, spoken timing, AV, rights, or audience-effect proof.",
    }
