#!/usr/bin/env python3
# tools/save-what-you-watch-and-read/read-data/observe_files.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# Which files under a folder the person granted are new or have changed since the last time, matched by a pattern
# (a glob), and nothing about what the files mean. It runs on the person's computer:
#
#   python3 observe_files.py <granted folder>  < request
#
# The request is one JSON object on standard input:
#
#   source_ref        what this source is called (required): the name the observations are kept under
#   glob              the pattern, relative to the folder (default "**/*")
#   under             a path inside the folder to look in instead of the whole folder
#   account_prefix    when set, the folder (or `under`) holds one sub-folder for each account whose name starts with
#                     it, and each is looked in (`under_account` then names a path inside each)
#   under_account     a path inside each account folder
#   include_kinds     "file" and/or "directory" (default ["file"]): which kinds of entry are observed
#   since             the `next_since` of the answer before ({ files: { <path>: "<mtime_ns>:<size>" } }): an entry
#                     whose state is unchanged is not observed again, so the work is O(changed)
#   most              at most this many entries are observed in one answer, newest first (default 200, at most 5000);
#                     the rest are still new next time
#   with_hash         true: each observed FILE also gets its content identity (BLAKE3, `1f:`), up to `hash_up_to_bytes`
#                     (default 64 MiB); a larger file is observed without one. Default false: a state change is how
#                     a file is known to have changed
#   window            a number: instead of the above, the newest this-many files by modification time, found by their
#                     names and sizes alone. No file is opened; nothing is hashed; no `next_since` (a quick look, for a
#                     list on a screen)
#
# and the answer is its last line, `{"result": {...}}` or `{"error": "..."}` with a non-zero status when the request
# cannot be answered. A result holds `source_ref`, `observations` (each { source_ref, native_ref, observed_at, state,
# content_hash, payload: { store, kind, relative_path, account_dir, size_bytes, modified_at } }, newest first;
# `native_ref` is the path inside the granted folder), `next_since` (what to send as `since` next time) or null for a
# window, `more` (true when `most` cut the list), and `skipped` (entries it would not follow, with why).
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. It looks ONLY inside the folder the person granted. An entry that is a link leading out of the folder is skipped
#    and named in `skipped`, never read; a pattern or `under` that leaves the folder is refused. Nothing is written.
# 2. It never reads what a file means. The bytes of a file are read only to give its content identity, and only when
#    `with_hash` asks.
# 3. A window opens no file.
# 4. The state of an entry (`<mtime_ns>:<size>`) is what says it changed, so a re-run over an unchanged folder finds
#    nothing.
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
# The identity of bytes is the conversations folder's (one owner); a row of this tool packs that folder beside this one.
sys.path.insert(0, str(HERE.parents[1] / "conversations" / "read-data"))

from content_identity import content_hash, content_hash_chunks  # noqa: E402

DEFAULT_MOST, MOST_MOST = 200, 5000
DEFAULT_HASH_UP_TO = 64 * 1024 * 1024
KINDS = ("file", "directory")


class Refusal(Exception):
    """The request cannot be answered; the message says what to do."""


def _iso(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _inside(root, path):
    return os.path.commonpath([root, path]) == root


def _scan_roots(root, request):
    """[(directory to look in, account folder name or None)], every one inside the granted folder."""
    base = root
    if request.get("under") is not None:
        base = os.path.realpath(os.path.join(root, request["under"]))
        if not _inside(root, base):
            raise Refusal("under is outside the folder you granted; name a path inside it.")
    prefix = request.get("account_prefix")
    if not prefix:
        return [(base, None)] if os.path.isdir(base) else []
    if not os.path.isdir(base):
        return []
    found = []
    for name in sorted(os.listdir(base)):
        account = os.path.realpath(os.path.join(base, name))
        if not name.startswith(prefix) or not os.path.isdir(account) or not _inside(root, account):
            continue
        scan = os.path.realpath(os.path.join(account, request.get("under_account") or ""))
        if _inside(root, scan) and os.path.isdir(scan):
            found.append((scan, name))
    return found


def _entries(root, scan_roots, pattern, kinds):
    """(path, kind, stat, scan root, account) of every matching entry whose real path is inside the folder, and
    [(path, why)] of those it would not follow."""
    found, skipped = [], []
    for scan, account in scan_roots:
        for path in sorted(pathlib.Path(scan).glob(pattern)):
            try:
                if path.is_dir():
                    kind = "directory"
                elif path.is_file():
                    kind = "file"
                else:
                    continue
            except OSError:
                continue
            if kind not in kinds:
                continue
            real = os.path.realpath(path)
            if not _inside(root, real):
                skipped.append((os.path.relpath(path, root), "a link that leads out of the folder you granted"))
                continue
            try:
                found.append((path, kind, path.stat(), scan, account))
            except OSError:
                continue
    return found, skipped


def _observation(root, source_ref, entry, hashed):
    path, kind, stat, scan, account = entry
    return {
        "source_ref": source_ref,
        "native_ref": os.path.relpath(path, root),
        "observed_at": _iso(datetime.datetime.now(datetime.timezone.utc).timestamp()),
        "state": f"{stat.st_mtime_ns}:{stat.st_size}",
        "content_hash": hashed,
        "payload": {"store": "file", "kind": kind, "relative_path": os.path.relpath(path, scan),
                    "account_dir": account, "size_bytes": stat.st_size if kind == "file" else None,
                    "modified_at": _iso(stat.st_mtime)},
    }


def _count(value, default, most, name):
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= most:
        raise Refusal(f"{name} is a whole number from 1 to {most}.")
    return value


def observe(folder, request):
    """The answer to one request over the granted folder, or a Refusal."""
    if not isinstance(request, dict):
        raise Refusal("The request is one JSON object.")
    source_ref = request.get("source_ref")
    if not isinstance(source_ref, str) or not source_ref:
        raise Refusal("source_ref is required: what to call this source.")
    root = os.path.realpath(folder)
    if not os.path.isdir(root):
        raise Refusal("The folder you granted is not a folder.")
    pattern = request.get("glob") or "**/*"
    if not isinstance(pattern, str) or pattern.startswith(("/", "..")) or ".." in pathlib.PurePosixPath(pattern).parts:
        raise Refusal("glob is a pattern inside the folder, like **/*.jsonl; it cannot start from / or use ..")
    kinds = request.get("include_kinds") or ["file"]
    if not isinstance(kinds, list) or not kinds or any(kind not in KINDS for kind in kinds):
        raise Refusal(f"include_kinds is a list of {list(KINDS)}.")
    entries, skipped = _entries(root, _scan_roots(root, request), pattern, kinds)
    skipped = [{"path": path, "why": why} for path, why in skipped]

    if request.get("window") is not None:
        newest = sorted((e for e in entries if e[1] == "file"), key=lambda e: e[2].st_mtime_ns, reverse=True)
        taken = newest[:_count(request["window"], 1, MOST_MOST, "window")]
        return {"source_ref": source_ref, "observations": [_observation(root, source_ref, e, None) for e in taken],
                "next_since": None, "more": len(newest) > len(taken), "skipped": skipped}

    since = request.get("since") or {}
    known = since.get("files") if isinstance(since, dict) and isinstance(since.get("files"), dict) else {}
    most = _count(request.get("most"), DEFAULT_MOST, MOST_MOST, "most")
    hash_up_to = _count(request.get("hash_up_to_bytes"), DEFAULT_HASH_UP_TO, 2 ** 40, "hash_up_to_bytes")
    changed = [e for e in entries if known.get(os.path.relpath(e[0], root)) != f"{e[2].st_mtime_ns}:{e[2].st_size}"]
    changed.sort(key=lambda e: e[2].st_mtime_ns, reverse=True)
    taken = changed[:most]
    next_files = dict(known)
    observations = []
    for entry in taken:
        path, kind, stat = entry[0], entry[1], entry[2]
        state = f"{stat.st_mtime_ns}:{stat.st_size}"
        hashed = None
        if kind == "directory":
            hashed = content_hash(f"{os.path.relpath(path, root)}:{state}".encode("utf-8"))
        elif request.get("with_hash") and stat.st_size <= hash_up_to:
            try:
                with open(path, "rb") as handle:
                    hashed = content_hash_chunks(iter(lambda: handle.read(1024 * 1024), b""))
            except OSError:
                continue
        observations.append(_observation(root, source_ref, entry, hashed))
        next_files[os.path.relpath(path, root)] = state
    return {"source_ref": source_ref, "observations": observations, "next_since": {"files": next_files},
            "more": len(changed) > len(taken), "skipped": skipped}


def main(argv):
    if len(argv) != 2:
        print(json.dumps({"error": "observe_files.py needs the folder you granted: observe_files.py <folder>"}))
        return 2
    try:
        print(json.dumps({"result": observe(argv[1], json.loads(sys.stdin.read() or "null"))},
                         ensure_ascii=False, separators=(",", ":")))
        return 0
    except Refusal as refusal:
        print(json.dumps({"error": str(refusal)}))
        return 2
    except Exception as error:  # noqa: BLE001  (told, not a traceback)
        print(json.dumps({"error": f"The folder could not be read: {type(error).__name__}: {error}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
