#!/usr/bin/env python3
"""Name who said each stretch of a recording's transcript, against the voice prints a person enrolled.

Reads one JSON object on stdin:
  file             the recording (audio or video), as the local path the container was given
  segments         optional timed stretches [{ start, end, text }]; omitted: hear the recording with tools/audio-transcription
  voice_prints     the person's voice-print records (filled from their records)
  voice_sessions   the person's listening-voices records (filled from their records)
  listening        the listening this recording belongs to; unknown voices keep their number across its recordings
  rules, words, join_within_seconds, max_seconds   optional; see read-data/who_is_in.py
Prints one JSON line: { speakers: [{ start, end, who, person, me, voice, score, unsure?, text }], voices_heard, records }.
`records` holds the listening's listening-voices record, which the tool keeps (kind listening-voices, stays on this device).
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import who_is_in  # noqa: E402


def value_of(record):
    if not isinstance(record, dict):
        return {}
    for key in ("value", "payload"):
        if isinstance(record.get(key), dict):
            return record[key]
    return record


def timed_segments(segments, *, supplied):
    if not isinstance(segments, list) or (supplied and not segments):
        raise who_is_in.Refused("Give the transcript's timed stretches.")
    previous = -1
    for segment in segments:
        if not isinstance(segment, dict):
            raise who_is_in.Refused("Each transcript stretch needs finite start and end seconds.")
        start, end = segment.get("start"), segment.get("end")
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in (start, end)) or start < 0 or end <= start or start < previous:
            raise who_is_in.Refused("Each transcript stretch needs finite, ordered start and end seconds.")
        if "text" in segment and not isinstance(segment["text"], str):
            raise who_is_in.Refused("A transcript stretch's text is words, not another value.")
        previous = start
    return segments


def analyse(request):
    if not isinstance(request, dict) or not isinstance(request.get("file"), str) or not request["file"]:
        raise who_is_in.Refused("Give the recording's file.")
    seconds = min(3600, max(30, int(request.get("max_seconds") or 3600)))
    # An explicit transcript is checked before loading models. Only omission asks the audio owner to hear the file.
    segments = timed_segments(request["segments"], supplied=True) if "segments" in request else None
    import measure
    if segments is None:
        segments = timed_segments(measure.transcript_segments(request["file"], seconds), supplied=False)
        segments = [segment for segment in segments if segment.get("text", "").strip()]
        if not segments:
            return {"speakers": [], "voices_heard": [], "records": []}
    listening = str(request.get("listening") or "listening")
    sessions = {value_of(row).get("listening"): value_of(row) for row in request.get("voice_sessions") or []}
    prints = [value_of(row) for row in request.get("voice_prints") or [] if value_of(row).get("samples")]
    vectors = measure.voice_vectors(request["file"], segments, seconds)
    answers, session = who_is_in.name_spans(segments, vectors, prints, sessions.get(listening), request.get("rules"))
    speakers = who_is_in.speakers_of(segments, answers, float(request.get("join_within_seconds") or 2.0), request.get("words"))
    record = {"kind": "listening-voices", "id": f"listening-voices:{who_is_in.slug(listening)}", "listening": listening, **session}
    return {"speakers": speakers, "voices_heard": [v["id"] for v in session["unknown"]], "records": [record],
                      "method": "CAM++ voice vectors of the transcript's stretches, cosine similarity to the enrolled prints",
            "warning": "A name is given only when one enrolled person is clearly the closest; otherwise the people it could be are listed."}


def main():
    print(json.dumps(analyse(json.load(sys.stdin)), separators=(",", ":")))


if __name__ == "__main__":
    main()
