#!/usr/bin/env python3
"""Name who said each stretch of a recording's transcript, against the voice prints a person enrolled.

Reads one JSON object on stdin:
  file             the recording (audio or video), as the local path the container was given
  segments         the transcript's timed stretches [{ start, end, text }], seconds (tools/audio-transcription answers them)
  voice_prints     the person's voice-print records (filled from their records)
  voice_sessions   the person's voice-session records (filled from their records)
  listening        the listening this recording belongs to; unknown voices keep their number across its recordings
  rules, words, join_within_seconds, max_seconds   optional; see read-data/who_is_in.py
Prints one JSON line: { speakers: [{ start, end, who, me, voice, score, unsure?, text }], voices_heard, records }.
`records` holds the listening's voice-session record, which the tool keeps (kind voice-session, stays on this device).
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import measure  # noqa: E402
import who_is_in  # noqa: E402


def value_of(record):
    if not isinstance(record, dict):
        return {}
    for key in ("value", "payload"):
        if isinstance(record.get(key), dict):
            return record[key]
    return record


def main():
    request = json.load(sys.stdin)
    segments = request.get("segments")
    if not isinstance(segments, list) or not segments:
        raise who_is_in.Refused("Give the transcript's timed stretches.")
    listening = str(request.get("listening") or "listening")
    sessions = {value_of(row).get("listening"): value_of(row) for row in request.get("voice_sessions") or []}
    prints = [value_of(row) for row in request.get("voice_prints") or [] if value_of(row).get("samples")]
    vectors = measure.voice_vectors(request["file"], segments, min(3600, max(30, int(request.get("max_seconds") or 3600))))
    answers, session = who_is_in.name_spans(segments, vectors, prints, sessions.get(listening), request.get("rules"))
    speakers = who_is_in.speakers_of(segments, answers, float(request.get("join_within_seconds") or 2.0), request.get("words"))
    record = {"kind": "voice-session", "id": f"voice-session:{who_is_in.slug(listening)}", "listening": listening, **session}
    print(json.dumps({"speakers": speakers, "voices_heard": [v["id"] for v in session["unknown"]], "records": [record],
                      "method": "CAM++ voice vectors of the transcript's stretches, cosine similarity to the enrolled prints",
                      "warning": "A name is given only when one enrolled person is clearly the closest; otherwise the people it could be are listed."},
                     separators=(",", ":")))


if __name__ == "__main__":
    main()
