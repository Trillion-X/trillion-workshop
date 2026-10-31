#!/usr/bin/env python3
"""Enrol a person's voice or face, with the consent words that say who agreed and how.

Reads one JSON object on stdin:
  kind             "voice" or "face"
  name             the person's name
  consent          who agreed to be known by their voice or face, and how; refused when empty, before anything is measured
  me               optional, true when this is the person who owns the records
  file             a recording of the voice, or a picture or video holding the face, as the local path the container was given
  heard_voice      instead of `file` for a voice: a voice-N label heard in `listening`
  listening        the listening `heard_voice` was heard in
  voice_prints, face_prints, voice_sessions   the person's records of those kinds (filled from their records)
  models           optional, for running it by hand: { detector, recognizer } paths
Prints one JSON line: { person, kind, samples, heard_as?, records }. `records` holds the new or extended print record,
which the tool keeps (kinds voice-print and face-print stay on this device). The numbers of the print are only in that record.
"""

import json
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


def main():
    request = json.load(sys.stdin)
    kind = request.get("kind")
    # Consent and kind are checked before any model is loaded or any file is read.
    who_is_in.kind_of(kind)
    who_is_in.consented(request.get("consent"))
    name = str(request.get("name") or "").strip()
    heard_as = []
    if kind == "voice" and request.get("heard_voice"):
        sessions = {value_of(row).get("listening"): value_of(row) for row in request.get("voice_sessions") or []}
        vector, heard_as = who_is_in.heard_voice_as_sample(sessions.get(str(request.get("listening") or "listening")), request["heard_voice"])
        vectors = [vector]
    elif kind == "voice":
        import measure
        vectors = measure.speech_vectors(request["file"], 3600)
        if not vectors:
            raise who_is_in.Refused("That recording holds too little speech to measure a voice.")
    else:
        import measure
        finder = measure.face_finder(request.get("models"))
        pictures = [measure.picture(request["file"])] if measure.is_picture(request["file"]) else [p for _, p in measure.video_pictures(request["file"], 2)]
        found = [(rgb, face) for rgb in pictures for face in finder.find(rgb)]
        if not found:
            raise who_is_in.Refused("No face was found in that picture.")
        # The largest face is the person being enrolled.
        rgb, face = max(found, key=lambda pair: (pair[1][2] - pair[1][0]) * (pair[1][3] - pair[1][1]))
        vectors = [finder.print_of(rgb, face).tolist()]
    spec = who_is_in.kind_of(kind)
    earlier = {value_of(row).get("person"): value_of(row) for row in request.get(f"{kind}_prints") or []}
    record = who_is_in.print_record(kind, name, vectors, request.get("consent"), earlier.get(who_is_in.slug(name)), bool(request.get("me")))
    out = {"person": record["value"]["person"], "kind": kind, "samples": len(record["value"]["samples"]), "records": [{"kind": spec["record"], "id": record["id"], **record["value"]}]}
    if heard_as:
        out["heard_as"] = heard_as
    print(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
