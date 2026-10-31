#!/usr/bin/env python3
# tools/conversations/read-data/decode_source.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# The one command that turns an export of someone's conversations into the canonical threads and atoms, and into
# conversations ready for the owner that keeps messages. It runs on the person's computer over ONE folder they
# granted it to read:
#
#   python3 decode_source.py <granted folder> [--sources <table.json> ...]  < request
#   python3 decode_source.py --list [--sources <table.json> ...]
#
# The request is one JSON object on standard input:
#
#   file          the export, a path inside the granted folder (required)
#   source        the id of the row of read-data/sources.json that reads it; left out, the file is matched to a row
#                 by what it looks like (choose_source.py), and a file several rows could read is refused with
#                 their ids
#   sources_file  a file inside the folder holding the person's own rows ({"sources": [...]}); a row with the id
#                 of a built-in one replaces it, any other is added
#   descriptor    the run's own choices: `mailbox_address` (which address is "me", for mail), `expected_provider`
#                 (for a web capture), `source_ref` (what to call this source; `source:<row id>` when left out),
#                 `app` (the name the conversations are kept under), `display_mark_ref`
#   mode          "all" (default): the threads and atoms of the whole export, a page of atoms at a time
#                 "threads": the list of threads only, newest first, a page at a time
#                 "page": one thread's newest messages first from `before_cursor`, for a very large single log
#   cursor, limit the page asked for ("all": an atom offset, at most 2000 atoms, 200 when left out; "threads": a
#                 thread offset, at most 64; "page": `before_cursor`, `limit` and `session_id` name the page)
#
# and the answer is its last line, `{"result": {...}}` or `{"error": "..."}` with a non-zero status when the request
# cannot be answered honestly. A result holds the source, `threads`, `atoms`, `conversations` (read-data/
# for_recording.py; only for a source that is conversations, not for saved pins or bookmarks), `rejections` (one
# structured entry for each thing the export could not give), and `next_cursor` where there is more.
#
# Two more arguments: `--sources <table.json>` adds the rows of a table the tool carries (a tool that packs this
# folder reads its own kinds of export that way), and `--list` prints what the tables can read, with no folder.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. It reads ONLY inside the folder the person granted. A path that leaves the folder, by `..` or by a link that
#    points out of it, is refused; nothing is written anywhere.
# 2. NO NETWORK, NO TOKEN. A connector that pulls from a service leaves a file; this reads the file.
# 3. A row is DATA. This file knows no app, no service and no format: it picks the module a row's `reader` names and
#    hands it the file.
# 4. A page is bounded: the answer is never the whole of a large export at once.
#
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
from __future__ import annotations

import datetime
import json
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import choose_source  # noqa: E402
import for_recording  # noqa: E402
import read_source  # noqa: E402
import read_web_capture  # noqa: E402
from content_identity import content_hash  # noqa: E402

DEFAULT_ATOMS, MOST_ATOMS, MOST_THREADS = 200, 2000, 64
MODES = ("all", "threads", "page")


class Refusal(Exception):
    """The request cannot be answered; the message says what to do."""


def load_rows(table_files, extra_rows=None):
    """The rows of the tables named, later tables and `extra_rows` replacing a row of the same id."""
    rows = {}
    for table in table_files:
        loaded = json.loads(pathlib.Path(table).read_text(encoding="utf-8"))
        for row in loaded.get("sources", []):
            rows[row["id"]] = row
    for row in extra_rows or []:
        rows[row["id"]] = row
    return rows


def inside(folder, relative, what):
    """The real path of `relative` under the granted folder, or a refusal when it is not under it (a `..`, or a
    link that leads out)."""
    root = os.path.realpath(folder)
    if not isinstance(relative, str) or not relative:
        raise Refusal(f"{what} is required: the path of the file inside the folder you granted.")
    target = os.path.realpath(os.path.join(root, relative))
    if os.path.commonpath([root, target]) != root:
        raise Refusal(f"{what} ({relative}) is outside the folder you granted; name a file inside it.")
    if not os.path.exists(target):
        raise Refusal(f"{what} ({relative}) is not in the folder you granted.")
    return target


def person_rows(folder, relative):
    path = inside(folder, relative, "sources_file")
    try:
        loaded = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise Refusal(f"sources_file ({relative}) is not readable JSON: {error}") from error
    rows = loaded.get("sources") if isinstance(loaded, dict) else None
    if not isinstance(rows, list) or not all(isinstance(row, dict) and row.get("id") for row in rows):
        raise Refusal('sources_file holds {"sources": [row, ...]} with an id on every row.')
    return rows


def pick_row(rows, wanted, path):
    if wanted:
        if wanted not in rows:
            raise Refusal(f"source {wanted!r} is not a known source; the known ones are {sorted(rows)}.")
        return rows[wanted]
    fitting = choose_source.choose(list(rows.values()), path)
    if len(fitting) == 1:
        return rows[fitting[0]]
    if not fitting:
        raise Refusal(f"No source reads this file. Name one in `source`, or add a row of your own in `sources_file`; "
                      f"the known sources are {sorted(rows)}.")
    raise Refusal(f"More than one source could read this file ({fitting}); name the right one in `source`.")


def observation_of(path, relative, row, descriptor):
    stat = os.stat(path)
    source_ref = descriptor.get("source_ref") or f"source:{row['id']}"
    state = f"{stat.st_mtime_ns}:{stat.st_size}"
    return {"source_ref": source_ref, "native_ref": path,
            "batch_ref": "batch:" + content_hash(f"{source_ref}\0{relative}\0{state}".encode("utf-8"))[3:],
            "observed_at": datetime.datetime.fromtimestamp(stat.st_mtime, datetime.timezone.utc)
                                    .isoformat(timespec="seconds").replace("+00:00", "Z")}


def _count(value, default, most, name):
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= most:
        raise Refusal(f"{name} is a whole number from 1 to {most}.")
    return value


def _offset(value, name):
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise Refusal(f"{name} is a whole number from 0, the next_cursor an earlier answer gave.")
    return value


def kept_as_conversations(threads, atoms, row, descriptor):
    """{"conversations": ...} for a source that is conversations (its row has `recording`), else nothing: a saved
    pin or bookmark is not a conversation."""
    if not row.get("recording"):
        return {}
    return {"conversations": for_recording.conversations_for_recording(threads, atoms, row, descriptor)}


def answer_all(observation, row, descriptor, request):
    limit = _count(request.get("limit"), DEFAULT_ATOMS, MOST_ATOMS, "limit")
    start = _offset(request.get("cursor"), "cursor")
    decoded = read_source.decode(observation, row, descriptor)
    atoms = decoded.get("atoms", [])
    page = atoms[start:start + limit]
    kept = {atom["thread_ref"] for atom in page}
    threads = [thread for thread in decoded.get("threads", []) if thread["thread_ref"] in kept]
    end = start + len(page)
    result = {"threads": threads, "atoms": page, "total_atoms": len(atoms),
              **kept_as_conversations(threads, page, row, descriptor),
              "rejections": decoded.get("rejections", []), "next_cursor": end if end < len(atoms) else None}
    if decoded.get("next_cursor") is not None:
        result["source_next_cursor"] = decoded["next_cursor"]
    return result


def answer_threads(observation, row, descriptor, request):
    limit = _count(request.get("limit"), MOST_THREADS, MOST_THREADS, "limit")
    start = _offset(request.get("cursor"), "cursor")
    if row.get("reader") == "sqlite-rows":
        decoded = read_source.decode_sqlite_summary(observation, row, descriptor)
    else:
        decoded = read_source.decode(observation, row, descriptor)
    threads = sorted(decoded.get("threads", []), key=lambda thread: (
        str(thread.get("last_activity_at") or thread.get("started_at") or ""), str(thread["thread_ref"])), reverse=True)
    page = threads[start:start + limit]
    end = start + len(page)
    return {"threads": page, "total_threads": len(threads), "rejections": decoded.get("rejections", []),
            "next_cursor": end if end < len(threads) else None}


def answer_page(observation, row, descriptor, request):
    limit = _count(request.get("limit"), DEFAULT_ATOMS, MOST_ATOMS, "limit")
    session_id = request.get("session_id")
    window = read_source.decode_window(observation, row, descriptor, request.get("before_cursor"), limit, session_id)
    thread = {"thread_ref": f"thread:{observation['source_ref']}:{window['session_id']}",
              "presentation": {"title": window.get("title")}}
    atoms = window.get("atoms", [])
    return {"window": {key: window[key] for key in window if key != "atoms"}, "atoms": atoms,
            **kept_as_conversations([thread], atoms, row, descriptor),
            "rejections": [], "next_cursor": window.get("older_cursor") if window.get("has_older") else None}


def answer_web_capture(observation, row, descriptor, request):
    decoded = read_web_capture.decode_request(
        {"observation": observation, "descriptor": descriptor, "cursor": request.get("cursor"),
         "limit": request.get("limit", 50), "category_key": request.get("category_key", "threads")}, row)
    return {"threads": decoded["threads"], "atoms": decoded["atoms"],
            **kept_as_conversations(decoded["threads"], decoded["atoms"], row, descriptor),
            "rejections": decoded["rejections"], "next_cursor": decoded.get("next_cursor"),
            "snapshot_revision": decoded.get("snapshot_revision")}


def run(folder, tables, request):
    """The answer to one request over the granted folder, or a Refusal."""
    if not isinstance(request, dict):
        raise Refusal("The request is one JSON object.")
    mode = request.get("mode", "all")
    if mode not in MODES:
        raise Refusal(f"mode is one of {list(MODES)}.")
    descriptor = request.get("descriptor") or {}
    if not isinstance(descriptor, dict):
        raise Refusal("descriptor is an object.")
    rows = load_rows(tables, person_rows(folder, request["sources_file"]) if request.get("sources_file") else None)
    relative = request.get("file")
    path = inside(folder, relative, "file")
    row = pick_row(rows, request.get("source"), path)
    observation = observation_of(path, relative, row, descriptor)
    if row.get("reader") == "web-capture":
        body = answer_web_capture(observation, row, descriptor, request)
    elif mode == "threads":
        body = answer_threads(observation, row, descriptor, request)
    elif mode == "page":
        body = answer_page(observation, row, descriptor, request)
    else:
        body = answer_all(observation, row, descriptor, request)
    return {"source": row["id"], "source_ref": observation["source_ref"], "mode": mode, **body}


def list_sources(tables):
    """What the tables can read, one entry for each row: its id, what it is, the format it reads, the choices the run
    must make for it (`needs`), the name its conversations are kept under, and what its files look like."""
    sources = [{"id": row["id"], "label": row.get("label"), "format": row.get("format_version"),
                "reader": row.get("reader"), "needs": (row.get("mail") or {}).get("needs", []) +
                (["expected_provider"] if row.get("reader") == "web-capture" else []),
                "app": (row.get("recording") or {}).get("app"), "files_look_like": row.get("input_shape")}
               for row in load_rows(tables).values()]
    return {"said": f"{len(sources)} kinds of export can be read: " + ", ".join(source["id"] for source in sources),
            "sources": sources}


def main(argv):
    arguments, tables, listing, index = [], [HERE / "sources.json"], False, 1
    while index < len(argv):
        if argv[index] == "--list":
            listing, index = True, index + 1
        elif argv[index] == "--sources" and index + 1 < len(argv):
            tables.append(argv[index + 1])
            index += 2
        elif argv[index].startswith("--"):
            print(json.dumps({"error": f"unknown argument {argv[index]!r}"}))
            return 2
        else:
            arguments.append(argv[index])
            index += 1
    if listing:
        print(json.dumps({"result": list_sources(tables)}, ensure_ascii=False, separators=(",", ":")))
        return 0
    if len(arguments) != 1:
        print(json.dumps({"error": "decode_source.py needs the folder you granted: decode_source.py <folder>"}))
        return 2
    folder = arguments[0]
    try:
        request = json.loads(sys.stdin.read() or "null")
        print(json.dumps({"result": run(folder, tables, request)}, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Refusal as refusal:
        print(json.dumps({"error": str(refusal)}))
        return 2
    except Exception as error:  # noqa: BLE001  (a row of the person's own that does not fit is told, not a traceback)
        print(json.dumps({"error": f"The export could not be read with this source: {type(error).__name__}: {error}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
