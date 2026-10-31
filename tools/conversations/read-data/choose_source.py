#!/usr/bin/env python3
# tools/conversations/read-data/choose_source.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# Which row of read-data/sources.json reads this file, when the person did not say. A row says what its files look
# like in `input_shape`; this reads the file just enough to test each row against it and returns the ids that fit:
#
#   extensions      the file name ends with one of these
#   media_types     a JSON file reads as JSON (the one media type this checks), a .eml as message/rfc822
#   required_paths  paths that must all resolve in the JSON file's root
#   message_paths   paths that must all resolve in ONE message of the file: a dict anywhere in the first levels of
#                   the lists under the root's first required path
#   required_json_keys  keys the first record of a JSON array holds
#   line_paths      paths that must all resolve in a dict of the first lines of a JSON-lines file
#   sqlite_tables   tables a SQLite file holds
#
# A file that fits one row names it; a file that fits several is ambiguous and the caller must name the row; a file
# that fits none is no known source. The rows are DATA, so a person's own rows (--sources) are chosen from the same
# way, and a new source is a new row.
#
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
from __future__ import annotations

import json
import pathlib
import sqlite3

MAX_JSON_BYTES = 64 * 1024 * 1024
LINES_LOOKED_AT = 20
NODES_LOOKED_AT = 2000
LEVELS_LOOKED_AT = 5

EXTENSION_MEDIA_TYPES = {".eml": "message/rfc822", ".json": "application/json", ".jsonl": "application/x-ndjson"}


def _walk(node, path):
    for key in path:
        if isinstance(node, dict):
            node = node.get(key)
        elif isinstance(node, list) and isinstance(key, int) and not isinstance(key, bool):
            node = node[key] if -len(node) <= key < len(node) else None
        else:
            return None
    return node


def _present(node, path):
    found = _walk(node, path)
    return found is not None and found != ""


def _dicts_within(node, levels=LEVELS_LOOKED_AT, budget=None):
    """Every dict reachable through lists and dict values, breadth first, within a few levels and a budget of
    nodes, so a huge file is never walked whole."""
    budget = [NODES_LOOKED_AT] if budget is None else budget
    queue, level = [node], 0
    while queue and level <= levels and budget[0] > 0:
        following = []
        for item in queue:
            budget[0] -= 1
            if budget[0] < 0:
                return
            if isinstance(item, dict):
                yield item
                following.extend(value for value in item.values() if isinstance(value, (dict, list)))
            elif isinstance(item, list):
                following.extend(value for value in item if isinstance(value, (dict, list)))
        queue, level = following, level + 1


def _read_json(path):
    try:
        if path.stat().st_size > MAX_JSON_BYTES:
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _first_lines(path):
    found = []
    try:
        with open(path, "rb") as handle:
            for raw in handle:
                if len(found) >= LINES_LOOKED_AT:
                    break
                try:
                    event = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(event, dict):
                    found.append(event)
    except OSError:
        return []
    return found


def _sqlite_tables(path):
    try:
        connection = sqlite3.connect(f"{pathlib.Path(path).resolve().as_uri()}?mode=ro", uri=True)
        try:
            return {name for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        finally:
            connection.close()
    except sqlite3.Error:
        return set()


class _File:
    """What is read of the file, once, however many rows ask."""

    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.suffix = self.path.suffix.lower()
        self._json, self._lines, self._tables = False, None, None

    def json(self):
        if self._json is False:
            self._json = _read_json(self.path)
        return self._json

    def lines(self):
        if self._lines is None:
            self._lines = _first_lines(self.path)
        return self._lines

    def tables(self):
        if self._tables is None:
            self._tables = _sqlite_tables(self.path)
        return self._tables


def fits(row, file):
    """True when the file looks the way the row says its files look. A row with no `input_shape` fits nothing."""
    shape = row.get("input_shape")
    if not shape:
        return False
    if "extensions" in shape and file.suffix not in shape["extensions"]:
        return False
    if "media_types" in shape:
        media = EXTENSION_MEDIA_TYPES.get(file.suffix)
        if media is not None and media not in shape["media_types"]:
            return False
    if "sqlite_tables" in shape:
        return set(shape["sqlite_tables"]) <= file.tables()
    if "line_paths" in shape:
        return any(all(_present(event, path) for path in shape["line_paths"]) for event in file.lines())
    if "required_paths" in shape or "required_json_keys" in shape or "message_paths" in shape:
        root = file.json()
        if root is None:
            return False
        if "required_json_keys" in shape:
            first = root[0] if isinstance(root, list) and root else root
            if not (isinstance(first, dict) and all(key in first for key in shape["required_json_keys"])):
                return False
        required = shape.get("required_paths") or []
        if required and not (isinstance(root, dict) and all(_present(root, path) for path in required)):
            return False
        if "message_paths" in shape:
            scope = _walk(root, required[0]) if required else root
            return any(all(_present(item, path) for path in shape["message_paths"]) for item in _dicts_within(scope))
    return True


def choose(rows, path):
    """The ids of the rows that read the file at `path`, in the rows' order."""
    file = _File(path)
    return [row["id"] for row in rows if fits(row, file)]
