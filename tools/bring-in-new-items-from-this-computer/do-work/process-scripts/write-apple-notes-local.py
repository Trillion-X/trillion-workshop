#!/usr/bin/env python3
# packages/observed-content/do-work/process-scripts/write-apple-notes-local.py
#
# Purpose: The OUTBOUND mirror of observe-apple-notes-local.py — push a package
# record's content BACK to a local Apple-Notes markdown directory (one file per
# note). This is the reverse leg of the bidirectional external-endpoint sync
# (WS-B): the observer watches `location` for changes and emits records; this
# writer takes a record and writes a `<title>.md` file into that same
# `location`, so a round-trip (observe -> edit in a package -> write back) lands
# in the exact directory the observer reads.
#
# Same contract as the observer: format-blind, descriptor-DATA-driven (the
# target directory is DATA in `location`, never code — point it at a
# Notes.app-exported folder, an iCloud Drive sync folder, or any markdown-note
# directory), fail-closed (an unwritable/absent target directory emits a
# structured error record, never a silent success), and idempotent (a note
# whose on-disk content already equals what we would write is SKIPPED).
#
# Invocation:
#   python write-apple-notes-local.py <descriptor.json> <record.json> <output.json>
#
# descriptor.json structure:
#   {
#     "sink_ref": "apple-notes-local",
#     "location": "/path/to/notes-directory",
#     "encoder_capability_ref": "markdown-note-encoder"
#   }
#
# record.json structure (self-describing; source_kind selects THIS writer, L090):
#   {
#     "record_id": "doc:abc123",
#     "source_kind": "apple-notes",
#     "title": "My note",              # becomes <slug>.md
#     "text": "The note body."
#   }
#
# output.json: a single record kind="external-content-write-result"
#   { "kind":"external-content-write-result", "sink_ref":"apple-notes-local",
#     "record_id":"doc:abc123", "status":"written|skipped|error",
#     "external_ref":"<file path>", "error": null|"..." }

import json
import pathlib
import re
import sys


def read_json(path_text: str):
    return json.loads(pathlib.Path(path_text).read_text(encoding="utf-8"))


def write_json(path_text: str, value):
    pathlib.Path(path_text).write_text(
        json.dumps(value, separators=(",", ":")), encoding="utf-8"
    )


def slugify(title: str) -> str:
    """A filesystem-safe file stem derived from the note title. Empty/degenerate
    titles fall back to 'untitled' so a write never targets a dotfile or ''."""
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", title.strip()).strip("-.")
    return slug or "untitled"


def note_body(title: str, text: str) -> str:
    """The on-disk note format the observer's markdown-note-decoder reads back:
    a leading `# <title>` line followed by the body. Deterministic so the
    idempotency compare is exact."""
    return f"# {title}\n\n{text}\n"


def result_record(sink_ref, record_id, status, external_ref=None, error=None):
    return {
        "kind": "external-content-write-result",
        "sink_ref": sink_ref,
        "record_id": record_id,
        "status": status,
        "external_ref": external_ref,
        "error": error,
    }


def _emit(output_path, value):
    """Write the result either to a file path (argv mode) or to stdout when the
    output path is '-' (env/workflow-action mode, where compute.process captures
    stdout)."""
    if output_path == "-":
        sys.stdout.write(json.dumps(value, separators=(",", ":")))
    else:
        write_json(output_path, value)


def main(argv):
    # TWO invocation modes, same logic (L090 — the writer is interface-blind):
    #   (a) argv files:  write-apple-notes-local.py <descriptor.json> <record.json> <output.json>
    #   (b) env JSON:     SINK_JSON=... RECORD_JSON=... [OUTPUT_PATH=-]  (workflow-action /
    #       compute.process drive, mirroring the proven inbound observer's DESCRIPTOR_JSON env).
    import os

    if len(argv) == 4:
        descriptor_path, record_path, output_path = argv[1:4]
        descriptor = read_json(descriptor_path)
        record = read_json(record_path)
    elif os.environ.get("SINK_JSON") and os.environ.get("RECORD_JSON"):
        descriptor = json.loads(os.environ["SINK_JSON"])
        record = json.loads(os.environ["RECORD_JSON"])
        output_path = os.environ.get("OUTPUT_PATH", "-")
    else:
        sys.stderr.write(
            "usage: write-apple-notes-local.py <descriptor.json> <record.json> <output.json>\n"
            "   or: SINK_JSON=.. RECORD_JSON=.. [OUTPUT_PATH=-] write-apple-notes-local.py\n"
        )
        return 2

    sink_ref = descriptor.get("sink_ref", "apple-notes-local")
    record_id = record.get("record_id", "")
    title = record.get("title", "Untitled")
    text = record.get("text", "")
    location = descriptor.get("location")

    if not location:
        _emit(output_path, result_record(sink_ref, record_id, "error", None, "descriptor missing 'location' (target notes directory)"))
        return 1

    target_dir = pathlib.Path(location).expanduser()
    if not target_dir.exists() or not target_dir.is_dir():
        _emit(output_path, result_record(sink_ref, record_id, "error", None, f"location is not an existing directory: {location}"))
        return 1

    note_path = target_dir / f"{slugify(title)}.md"
    desired = note_body(title, text)

    # Idempotency: if the note already holds exactly this content, skip — never
    # rewrite identical bytes (would bump mtime and re-trigger the observer).
    try:
        if note_path.exists() and note_path.read_text(encoding="utf-8") == desired:
            _emit(output_path, result_record(sink_ref, record_id, "skipped", str(note_path)))
            return 0
    except OSError:
        pass  # fall through to attempt the write; a real failure surfaces below

    try:
        note_path.write_text(desired, encoding="utf-8")
    except OSError as exc:
        _emit(output_path, result_record(sink_ref, record_id, "error", str(note_path), f"write failed: {exc}"))
        return 1

    _emit(output_path, result_record(sink_ref, record_id, "written", str(note_path)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
