#!/usr/bin/env python3
"""Find the faces in a picture or a video and name those that match a face print a person enrolled.

Reads one JSON object on stdin:
  file             the picture or video, as the local path the container was given
  every_seconds    for a video, how often a picture is taken from it (default 2)
  face_prints      the person's face-print records (filled from their records)
  rules, models    optional; see read-data/who_is_in.py (FACE_RULES); models is { detector, recognizer } for running it by hand
Prints one JSON line: { faces: [{ at, box, who, score, unsure, found }] }. `at` is the second in a video (0 for a picture),
`box` is [x1, y1, x2, y2] in pixels, `who` is { id, name, me } or null, `found` is the detector's score. A face is named
only when one enrolled person is clearly the closest; otherwise `unsure` lists the people it could be.
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
    prints = [value_of(row) for row in request.get("face_prints") or [] if value_of(row).get("samples")]
    finder = measure.face_finder(request.get("models"))
    every = float(request.get("every_seconds") or 2)
    pictures = [(0, measure.picture(request["file"]))] if measure.is_picture(request["file"]) else list(measure.video_pictures(request["file"], every))
    out = []
    for at, rgb in pictures:
        found = finder.find(rgb)
        named = who_is_in.name_faces([finder.print_of(rgb, face).tolist() for face in found], prints, request.get("rules"))
        for face, answer in zip(found, named):
            out.append({"at": at, "box": [round(float(x), 1) for x in face[:4]], "found": round(float(face[4]), 3), **answer})
    print(json.dumps({"faces": out}, separators=(",", ":")))


if __name__ == "__main__":
    main()
