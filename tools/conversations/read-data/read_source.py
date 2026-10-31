#!/usr/bin/env python3
# tools/conversations/read-data/read_source.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# The ONE reader for every conversation or activity export whose shape is only
# field mapping: a JSON file, JSON lines, or rows a SQLite query returns. Which
# fields hold the thread, the speaker, the time, the text and the attachments is
# DATA: one source row in read-data/sources.json (`shape`). This file names no
# app, no service and no export; a new source is a new row, never new code.
#
# It normalizes a snapshot into source-neutral `thread_specs` and hands them to
# the one mapper (transcript_mapper.py), which alone owns atom identity, thread
# and speaker references, the atom schema and thread presentation.
#
# =============================================================================
# THE SHAPE VOCABULARY (all DATA, read by `value()` and `holds()`)
# =============================================================================
#
# A getter is an object; a dumb JSON parser reads every piece of it:
#   {"path": [k, ...], "in": scope}   walk keys / list indexes from a scope
#                                      (scopes: snapshot, thread, message, item,
#                                      people, values, row; default: the current one)
#   {"file": "stem" | "name"}          the snapshot file's name, without or with suffix
#   {"value": name}                    a value the reader set (session_id, self, ...)
#   {"const": v}
#   {"first": [getter, ...]}           first present, non-empty value
#   {"all": [getter, ...], "join": s}  every one present -> joined, else absent
#   {"pair": [a, b], "join": s}        both -> "a<s>b"; one -> that one
#   {"parts": [getter, ...], "join": s, "unique": bool}
#                                      present text parts (list values spread) joined
#   {"each": getter, "get": getter}    a list: get from each element (scope item)
#   {"any": getter, "get": getter}     first element (list items or object values)
#                                      whose get is present
#   {"lookup": getter, "key": getter}  table[key]
#   {"if": condition, "then": getter, "else": getter}
#   {"others": "people", "join": s}    labels of the thread's people who are not self
#   {"sole_other": "people" | "speakers"}
#                                      the one person who is not self, else absent
#   {"first_other_speaker": true}      the first message speaker who is not me/them
# Any getter may carry "ops": [op, ...], value operations applied in order:
#   {"op": "text"}  non-blank string or absent      {"op": "string"}
#   {"op": "time", "from": "iso" | "iso-checked" | "iso-normalized" | "epoch-seconds" |
#                  "epoch-ms" | "epoch-ms-micro" | "epoch-auto" | "epoch-auto-ms" |
#                  "decimal-seconds" | "apple-epoch"}
#   {"op": "before", "sep": s}  {"op": "match", "pattern": re, "group": n}
#   {"op": "template", "text": "...{value}..."}   {"op": "block-text", "list": "first" | "join"}
#   {"op": "typedstream-text"}  {"op": "strip-prefixes", "prefixes": [{"prefix", "through"?}]}
#   {"op": "fold-at-least", "at_least": n, "minus": m}   {"op": "json"}
#   {"op": "slice", "to": n}    {"op": "strip-pattern", "pattern": re}
# A condition: {"equals": [a, b]}, {"present": getter}, {"truthy": getter},
#   {"in": getter, "values": [...]}, {"at_least": getter, "value": n},
#   {"every": getter, "get": getter, "equals": v}, {"not": c}, {"all": [c, ...]}
#   {"any_of": [c, ...]}
#
# A row may also carry `batch.category`, a getter naming which category a
# snapshot holds (its default included); `decode_batch` reads several snapshots of
# the row and keeps the requested category, one bounded page at a time.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. NO NETWORK, NO TOKEN. The pull lives in the connector that wrote the
#    snapshot; this reads a file (or a SQLite file read-only, in place).
# 2. Unreadable / malformed snapshot -> ONE structured rejection, never an
#    exception that kills the batch. A message with no renderable part is handed
#    to the mapper text-less (it drops it); placeholders are never invented.
# 3. "me" is a structural fact of the snapshot (a sender id equal to the
#    snapshot's own id, a from-me flag), declared in the row, never a source-name
#    branch.
# 4. The mapper is the ONLY owner of atom identity / thread_ref / speaker_ref /
#    presentation. This file never re-implements any of those.
# 5. A message's `index` is its position in the full source thread (or a durable
#    id the row names), so an atom keeps its identity whether it comes from a
#    full decode or a paged window.
#
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
from __future__ import annotations

import datetime
import importlib
import json
import pathlib
import re
import sqlite3
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import transcript_mapper as tm  # noqa: E402  (the ONE mapper)
from content_identity import content_hash  # noqa: E402

APPLE_EPOCH_OFFSET = 978307200


# ---------------------------------------------------------------------------
# Value operations: the physics of formats (time encodings, archived strings).
# ---------------------------------------------------------------------------
def _iso_from_seconds(seconds, timespec=None):
    stamp = datetime.datetime.fromtimestamp(seconds, tz=datetime.timezone.utc)
    text = stamp.isoformat(timespec=timespec) if timespec else stamp.isoformat()
    return text.replace("+00:00", "Z")


def _time(value, encoding):
    """One time value in the encoding the row declares -> ISO-8601 UTC, or None.
    Garbage is None (routes the atom into the mapper's no-convergence path,
    never a crash)."""
    try:
        if encoding == "iso":
            if isinstance(value, str) and value:
                return value
            return None
        if encoding == "iso-checked":
            if not isinstance(value, str):
                return None
            datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            return value
        if encoding == "iso-normalized":
            if not isinstance(value, str):
                return None
            if value.endswith("Z"):
                return value
            parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.isoformat().replace("+00:00", "Z")
        if encoding == "epoch-seconds":
            return _iso_from_seconds(int(value))
        if encoding == "epoch-ms":
            return _iso_from_seconds(int(value) / 1000.0)
        if encoding == "epoch-ms-micro":
            millis = int(value)
            return _iso_from_seconds(millis / 1000.0, "microseconds") if millis > 0 else None
        if encoding == "decimal-seconds":
            return _iso_from_seconds(float(value))
        if encoding == "epoch-auto":
            # Microseconds, milliseconds or seconds by magnitude; an ISO string
            # passes through; a serialized 64-bit {low, high} keeps its low word.
            if value is None or value == "":
                return None
            if isinstance(value, str):
                return value
            if isinstance(value, dict):
                value = value.get("low", value.get("value"))
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
                return None
            seconds = value / 1_000_000 if value > 1e15 else (value / 1000 if value > 1e12 else value)
            return _iso_from_seconds(seconds)
        if encoding == "epoch-auto-ms":
            # Seconds or milliseconds by magnitude; an ISO string passes through.
            if isinstance(value, str) and value:
                return value
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
                return None
            return _iso_from_seconds(value / 1000 if value > 1e12 else value)
        if encoding == "apple-epoch":
            # Nanoseconds since 2001-01-01 (current stores) or seconds (older ones).
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
                return None
            seconds = value / 1_000_000_000 if value > 1_000_000_000_000 else value
            return _iso_from_seconds(seconds + APPLE_EPOCH_OFFSET, "microseconds")
    except (TypeError, ValueError, OSError, OverflowError):
        return None
    raise ValueError(f"unknown time encoding {encoding!r}")


def typedstream_text(blob):
    """Read the backing string out of an archived attributed-string blob
    (`streamtyped`): the FIRST byte-array primitive (`+`) after the NSString
    class marker, with a variable length prefix (one byte; 0x81 => next 2 bytes
    little-endian; 0x82 => next 4 bytes little-endian) then the UTF-8 bytes.
    Attribute runs come after and are ignored. None when absent."""
    if blob is None:
        return None
    data = blob if isinstance(blob, (bytes, bytearray)) else bytes(blob)
    anchor = data.find(b"NSString")
    if anchor == -1:
        anchor = data.find(b"NSMutableString")
    if anchor == -1:
        return None
    plus = data.find(b"+", anchor)
    if plus == -1:
        return None
    p = plus + 1
    if p >= len(data):
        return None
    b0 = data[p]
    if b0 == 0x81:
        length = int.from_bytes(data[p + 1:p + 3], "little"); p += 3
    elif b0 == 0x82:
        length = int.from_bytes(data[p + 1:p + 5], "little"); p += 5
    else:
        length = b0; p += 1
    if length <= 0 or p + length > len(data):
        return None
    text = data[p:p + length].decode("utf-8", errors="replace")
    return text if text else None


def block_text(content, mode):
    """Plain text from a string, a content-block list, or a block object.
    mode "first": the first non-blank block; "join": every block, newline-joined."""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        text = content.get("text") or content.get("content") or content.get("message")
        return text if isinstance(text, str) else None
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str) and block.strip():
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text") or block.get("content")
                if isinstance(text, str) and text.strip():
                    parts.append(text)
            if parts and mode == "first":
                return parts[0]
        return "\n".join(parts) if parts else None
    return None


def _op(value, op):
    name = op.get("op")
    if name == "time":
        return _time(value, op.get("from", "iso"))
    if name == "text":
        return value if isinstance(value, str) and value.strip() else None
    if name == "nonempty-text":
        return value if isinstance(value, str) and value else None
    if name == "string":
        return None if value is None else str(value)
    if value is None:
        return None
    if name == "before":
        return str(value).split(op["sep"], 1)[0]
    if name == "match":
        found = re.fullmatch(op["pattern"], str(value))
        return found.group(op.get("group", 0)) if found else None
    if name == "template":
        return op["text"].replace("{value}", str(value))
    if name == "block-text":
        return block_text(value, op.get("list", "join"))
    if name == "typedstream-text":
        return typedstream_text(value)
    if name == "strip-prefixes":
        text = str(value)
        for rule in op["prefixes"]:
            if text.startswith(rule["prefix"]):
                through = rule.get("through")
                if through:
                    cut = text.find(through)
                    return text[cut + 1:] if cut != -1 else text[len(rule["prefix"]):]
                return text[len(rule["prefix"]):]
        return text
    if name == "fold-at-least":
        return value - op["minus"] if value >= op["at_least"] else value
    if name == "json":
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return value
    if name == "slice":
        return value[:op["to"]]
    if name == "strip-pattern":
        return re.sub(op["pattern"], "", value.strip()).strip()
    if name == "strip":
        return value.strip() if isinstance(value, str) else value
    raise ValueError(f"unknown value operation {name!r}")


# ---------------------------------------------------------------------------
# Getters and conditions over scopes.
# ---------------------------------------------------------------------------
def _present(value):
    return value is not None and value != ""


def _walk(node, path):
    for key in path:
        if isinstance(node, dict):
            node = node.get(key)
        elif isinstance(node, list) and isinstance(key, int) and not isinstance(key, bool):
            node = node[key] if -len(node) <= key < len(node) else None
        else:
            return None
    return node


class Scope:
    """The objects a getter may read: snapshot, thread, message, item, people,
    values, row, plus the snapshot file path. `current` is the default scope."""

    def __init__(self, path=None, **named):
        self.path = path
        self.named = named

    def with_(self, **named):
        merged = dict(self.named)
        merged.update(named)
        return Scope(self.path, **merged)


def value(getter, scope, current):
    """Evaluate one getter (DATA) in `scope`; `current` names the default scope."""
    if getter is None:
        return None
    result = _raw(getter, scope, current)
    for op in getter.get("ops") or []:
        result = _op(result, op)
    return result


def _raw(g, scope, current):
    if "path" in g:
        return _walk(scope.named.get(g.get("in", current)), g["path"])
    if "const" in g:
        return g["const"]
    if "value" in g:
        return (scope.named.get("values") or {}).get(g["value"])
    if "file" in g:
        path = pathlib.Path(scope.path or "")
        return path.stem if g["file"] == "stem" else path.name
    if "first" in g:
        for part in g["first"]:
            got = value(part, scope, current)
            if _present(got):
                return got
        return None
    if "all" in g:
        got = [value(part, scope, current) for part in g["all"]]
        return g.get("join", " ").join(str(v) for v in got) if all(_present(v) for v in got) else None
    if "pair" in g:
        a, b = (value(part, scope, current) for part in g["pair"])
        a = a.strip() if isinstance(a, str) and a.strip() else None
        b = b.strip() if isinstance(b, str) and b.strip() else None
        if a and b:
            return f"{a}{g.get('join', ': ')}{b}"
        return a or b
    if "parts" in g:
        parts = []
        for part in g["parts"]:
            got = value(part, scope, current)
            for item in (got if isinstance(got, list) else [got]):
                if isinstance(item, str) and item.strip():
                    parts.append(item.strip())
        if g.get("unique"):
            parts = list(dict.fromkeys(parts))
        return g.get("join", "\n").join(parts) if parts else None
    if "each" in g:
        items = value(g["each"], scope, current)
        if not isinstance(items, list):
            return []
        out = []
        for item in items:
            got = value(g["get"], scope.with_(item=item), "item")
            if _present(got):
                out.append(got)
        return out
    if "any" in g:
        node = value(g["any"], scope, current)
        children = node.values() if isinstance(node, dict) else (node if isinstance(node, list) else [])
        for child in children:
            if isinstance(child, dict):
                got = value(g["get"], scope.with_(item=child), "item")
                if _present(got):
                    return got
        return None
    if "lookup" in g:
        table = value(g["lookup"], scope, current)
        key = value(g["key"], scope, current)
        return table.get(key) if isinstance(table, dict) and key is not None else None
    if "if" in g:
        return value(g.get("then") if holds(g["if"], scope, current) else g.get("else"), scope, current)
    if "others" in g:
        people = scope.named.get("people") or {}
        me = (scope.named.get("values") or {}).get("self")
        labels = [label for uid, label in people.items() if uid != me]
        return g.get("join", ", ").join(labels) if labels else None
    if "sole_other" in g:
        values = scope.named.get("values") or {}
        me = values.get("self")
        if g["sole_other"] == "people":
            if me is None:
                return None
            others = {uid for uid in (scope.named.get("people") or {}) if uid != me}
        else:
            others = set(values.get("other_speakers") or ())
        return next(iter(others)) if len(others) == 1 else None
    if "first_other_speaker" in g:
        return (scope.named.get("values") or {}).get("first_other_speaker")
    raise ValueError(f"unknown getter {sorted(g)!r}")


def holds(condition, scope, current):
    """Evaluate one condition (DATA)."""
    if condition is None:
        return True
    if "every" in condition:
        items = value(condition["every"], scope, current)
        seen = {value(condition["get"], scope.with_(item=item), "item")
                for item in (items if isinstance(items, list) else []) if isinstance(item, dict)}
        seen.discard(None)
        return seen == {condition["equals"]}
    if "equals" in condition:
        a, b = (value(part, scope, current) for part in condition["equals"])
        return a is not None and b is not None and str(a) == str(b)
    if "present" in condition:
        return _present(value(condition["present"], scope, current))
    if "truthy" in condition:
        return bool(value(condition["truthy"], scope, current))
    if "in" in condition:
        return value(condition["in"], scope, current) in condition["values"]
    if "at_least" in condition:
        got = value(condition["at_least"], scope, current)
        return isinstance(got, (int, float)) and got >= condition["value"]
    if "not" in condition:
        return not holds(condition["not"], scope, current)
    if "all" in condition:
        return all(holds(part, scope, current) for part in condition["all"])
    if "any_of" in condition:
        return any(holds(part, scope, current) for part in condition["any_of"])
    raise ValueError(f"unknown condition {sorted(condition)!r}")


# ---------------------------------------------------------------------------
# Snapshot loading.
# ---------------------------------------------------------------------------
def _load(path, file_format):
    """A JSON file, or JSON lines as {"lines": [object, ...]} (blank and
    unparseable lines, and lines that are not objects, are skipped)."""
    text = pathlib.Path(path).read_text(encoding="utf-8")
    if file_format == "jsonl":
        lines = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict):
                lines.append(event)
        return {"lines": lines}
    if file_format != "json":
        raise ValueError(f"unknown file format {file_format!r}")
    return json.loads(text)


def _rejection(source_ref, path, expected, got):
    return {"source_ref": source_ref, "violation_path": path, "expected": expected, "got": got}


# ---------------------------------------------------------------------------
# Threads from a snapshot (JSON and JSON-lines sources).
# ---------------------------------------------------------------------------
def _people(thread_shape, scope):
    rule = thread_shape.get("people")
    if not rule:
        return {}
    table = {}
    for person in value(rule["list"], scope, "thread") or []:
        if not isinstance(person, dict):
            continue
        person_scope = scope.with_(item=person)
        uid = value(rule["id"], person_scope, "item")
        if uid is None:
            continue
        table[str(uid)] = value(rule["label"], person_scope, "item") or str(uid)
    return table


def _message_spec(shape, scope, position):
    """One source message -> a normalized mapper message spec."""
    rule = shape["message"]
    index_rule = rule.get("index")
    index = position if index_rule is None else value(index_rule, scope, "message")
    spec = {
        "index": index,
        "speaker": value(rule["speaker"], scope, "message"),
        "text": value(rule["text"], scope, "message"),
        "at": value(rule.get("at"), scope, "message"),
        "kind": rule.get("kind", "utterance"),
    }
    native = value(rule.get("native_ref"), scope, "message")
    if native is not None:
        spec["native_ref"] = str(native)
    for key in ("state_events", "relations"):
        if key in rule:
            spec[key] = value(rule[key], scope, "message") or []
    for key in tm.CARRIED_FIELDS:
        if key in rule:
            spec[key] = value(rule[key], scope, "message")
    return spec


def _keep_latest(messages, rule, scope):
    """Duplicate native ids keep one copy: the greatest (declared order fields,
    then the content identity of the whole record), so equal times never depend
    on input order. Messages without the key are all kept, after the rest."""
    by_key, anonymous = {}, []
    for position, message in messages:
        message_scope = scope.with_(message=message)
        key = value(rule["by"], message_scope, "message")
        if key is None:
            anonymous.append((position, message))
            continue

        def order(item):
            item_scope = scope.with_(message=item[1])
            fields = [str(value(field, item_scope, "message") or "") for field in rule["order"]]
            canonical = json.dumps(item[1], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            return (*fields, content_hash(canonical.encode("utf-8")))
        prior = by_key.get(key)
        if prior is None or order((position, message)) > order(prior):
            by_key[key] = (position, message)
    return list(by_key.values()) + anonymous


def _sort_messages(messages, rules, scope):
    def key(item):
        item_scope = scope.with_(message=item[1])
        parts = []
        for rule in rules:
            got = value(rule["get"], item_scope, "message")
            if rule.get("numeric_first"):
                try:
                    parts.append((0, int(got), ""))
                except (TypeError, ValueError):
                    parts.append((1, 0, str(got or "")))
            else:
                parts.append(str(got or ""))
        return tuple(parts)
    return sorted(messages, key=key)


def _title_from_messages(rule, specs):
    """The first message by a listed speaker whose text, with the declared
    pattern stripped, does not start with the skip prefix (wrapped machine text
    is never a title)."""
    for spec in specs:
        if spec.get("speaker") not in rule.get("speaker_in", []):
            continue
        text = spec.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        cleaned = text.strip()
        if rule.get("strip_pattern"):
            cleaned = re.sub(rule["strip_pattern"], "", cleaned).strip()
        if not cleaned or cleaned.startswith(rule.get("skip_prefix", "\0")):
            if rule.get("first_only"):
                return None
            continue
        return cleaned[:rule.get("max", tm.PREVIEW_CHARS)]
    return None


def _thread_spec(shape, scope, thread, source_messages):
    """One thread object (or a synthetic one) -> (thread_spec, rejection)."""
    tshape = shape["thread"]
    thread_scope = scope.with_(thread=thread)
    session_id = value(tshape["id"], thread_scope, "thread")
    if session_id is None:
        return None, tshape.get("missing_id_rejection") or {
            "violation_path": "thread.id", "expected": "thread id", "got": "missing"}
    session_id = str(session_id)
    values = dict(scope.named.get("values") or {})
    values["session_id"] = session_id
    self_rule = tshape.get("self")
    if self_rule:
        own = value(self_rule, thread_scope, "thread")
        values["self"] = str(own) if own is not None else None
    people = _people(tshape, thread_scope)
    thread_scope = thread_scope.with_(people=people, values=values)

    rule = shape["message"]
    items = [(position, m) for position, m in source_messages if isinstance(m, dict)]
    if rule.get("keep_latest"):
        items = _keep_latest(items, rule["keep_latest"], thread_scope)
    if rule.get("sort"):
        items = _sort_messages(items, rule["sort"], thread_scope)
    specs = []
    for position, message in items:
        message_scope = thread_scope.with_(message=message)
        if not holds(rule.get("include_when"), message_scope, "message"):
            continue
        specs.append(_message_spec(shape, message_scope, position))
    others = [s["speaker"] for s in specs if s.get("speaker") not in (None, "me", "them")]
    values["first_other_speaker"] = others[0] if others else None
    values["other_speakers"] = sorted(set(others))

    title = value(tshape.get("title"), thread_scope, "thread")
    if tshape.get("title_from_messages"):
        title = _title_from_messages(tshape["title_from_messages"], specs) or title
    spec = {"session_id": session_id, "title": title or session_id, "messages": specs}
    native = value(tshape.get("native_ref"), thread_scope, "thread")
    if native is not None:
        spec["native_ref"] = native
    send_ref = value(tshape.get("send_ref"), thread_scope, "thread")
    if send_ref is not None:
        spec["send_ref"] = str(send_ref)
    return spec, None


def _listed(found):
    return found if isinstance(found, list) else []


def _grouped(group, scope):
    """A flat message list grouped by the row's key, first-seen order kept. Each
    message keeps its position in the source list, or (`position: in-group`)
    its position among its group's own messages."""
    grouped, order = {}, []
    for position, message in enumerate(_listed(value(group["messages"], scope, "snapshot"))):
        if not isinstance(message, dict):
            continue
        key = value(group["by"], scope.with_(message=message), "message")
        if key is None:
            continue
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        at = len(grouped[key]) if group.get("position") == "in-group" else position
        grouped[key].append((at, message))
    return [({"__values": {"group_key": key}}, grouped[key]) for key in order]


def _threads(shape, scope):
    """Every (thread object, [(position, message)]) the row's `threads` rule finds:
      list            threads at a getter, each with its messages getter
      chats_or_group  the list when present, else a flat message list grouped by a key
      group           a flat message list grouped by a key
      fixed           threads the row names, each reading one list of the snapshot
      per_item        one thread per item of a list
      one             the whole file is one thread (its messages getter)"""
    rule = shape["threads"]
    if "chats_or_group" in rule:
        either = rule["chats_or_group"]
        if not _listed(value(either["list"], scope, "snapshot")):
            return _grouped(either["group"], scope)
        rule = {"list": either["list"], "messages": either["messages"], "dict_messages_only": True}
    if "list" in rule:
        out = []
        for thread in _listed(value(rule["list"], scope, "snapshot")):
            if not isinstance(thread, dict):
                continue
            messages = _listed(value(rule["messages"], scope.with_(thread=thread), "thread"))
            if rule.get("dict_messages_only"):
                messages = [m for m in messages if isinstance(m, dict)]
            out.append((thread, list(enumerate(messages))))
        return out
    if "group" in rule:
        return _grouped(rule["group"], scope)
    if "fixed" in rule:
        return [({"id": fixed["session_id"], "title": fixed["title"], "__values": fixed.get("values", {})},
                 list(enumerate(_listed(value(fixed["messages"], scope, "snapshot")))))
                for fixed in rule["fixed"]]
    if "per_item" in rule:
        return [(item, [(0, item)]) for item in _listed(value(rule["per_item"], scope, "snapshot"))
                if isinstance(item, dict)]
    if "one" in rule:
        return [({}, list(enumerate(_listed(value(rule["one"], scope, "snapshot")))))]
    raise ValueError(f"unknown threads rule {sorted(rule)!r}")


# Readers that are code, not field mapping, because their format is not a mapping (a mail wire, an event stream). Each
# is a module of this folder with `thread_specs(row, path, descriptor, observation)`; it may also have `next_cursor`
# (the page's own cursor) and `decode_window` (a page read its own way).
SPEC_READERS = {"mail": "read_mail", "session-events": "read_session_events"}


def spec_reader(row):
    """The module that reads this row's format, or None for a row read by field mapping or from a database."""
    name = SPEC_READERS.get(row.get("reader"))
    return importlib.import_module(name) if name else None


def thread_specs(row, path, descriptor=None, observation=None):
    """The snapshot at `path` -> ([thread_spec], [rejection without source_ref], snapshot). A row read by a module
    of its own (SPEC_READERS) is read by it; it gets the descriptor (for the person's own address, say) and the
    observation."""
    reader = spec_reader(row)
    if reader is not None:
        return reader.thread_specs(row, path, descriptor, observation)
    shape = row["shape"]
    snapshot = _load(path, row.get("file", {}).get("format", "json"))
    # The snapshot root is always an object: a bare list is put under the row's
    # `root_list_key`, a bare object under `root_object_key` (as a one-item list).
    root = snapshot
    if isinstance(snapshot, list):
        root = {shape["root_list_key"]: snapshot} if shape.get("root_list_key") else None
    elif isinstance(snapshot, dict) and shape.get("root_object_key"):
        root = {shape["root_object_key"]: [snapshot]}
    if not isinstance(root, dict):
        return None, {"violation_path": "native_ref", "expected": shape.get("root_expected", "JSON object"),
                      "got": type(snapshot).__name__}, snapshot
    scope = Scope(path, snapshot=root)
    values = {}
    if shape.get("self"):
        own = value(shape["self"], scope, "snapshot")
        values["self"] = str(own) if own is not None else None
    scope = scope.with_(values=values)

    specs, rejections, seen = [], [], set()
    for thread, messages in _threads(shape, scope):
        thread_scope = scope.with_(values={**values, **thread.get("__values", {})})
        spec, rejection = _thread_spec(shape, thread_scope, thread, messages)
        if rejection:
            if not shape["thread"].get("skip_without_id"):
                rejections.append(dict(rejection))
            continue
        if shape["thread"].get("skip_without_text") and not any(m.get("text") for m in spec["messages"]):
            continue
        if shape["thread"].get("unique"):
            if spec["session_id"] in seen:
                continue
            seen.add(spec["session_id"])
        specs.append(spec)
    return specs, rejections, snapshot


# ---------------------------------------------------------------------------
# Rows from a SQLite file (query text and column mapping are DATA).
# ---------------------------------------------------------------------------
def open_read_only(db_path):
    """Open a SQLite file read-only with its write-ahead log VISIBLE, so freshly
    arrived rows are seen. `immutable=1` (which ignores the log and hides new
    rows) is only the fallback when the copied log is momentarily inconsistent."""
    uri = pathlib.Path(db_path).resolve().as_uri()
    try:
        conn = sqlite3.connect(f"{uri}?mode=ro", uri=True)
        conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        return conn
    except sqlite3.Error:
        return sqlite3.connect(f"{uri}?mode=ro&immutable=1", uri=True)


def _columns(conn, table):
    try:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def _sql(text, optional_fragment):
    return text.replace("{optional}", optional_fragment)


def _state_events(rule_list, row, scope):
    """Self-describing lifecycle events, each emitted only when its column is
    truthy (never `delivered` for a zero flag). All AUTHORITATIVE (10)."""
    events = []
    row_scope = scope.with_(message=row)
    for rule in rule_list:
        if not holds(rule["when"], row_scope, "message"):
            continue
        events.append({"key": rule["key"], "at": value(rule.get("at"), row_scope, "message"),
                       "provenance": 10, "raw": rule["raw"] if isinstance(rule["raw"], str)
                       else value(rule["raw"], row_scope, "message")})
    return events


class SqliteSource:
    """A SQLite source whose queries and column mapping are the row's DATA."""

    def __init__(self, row, path):
        self.row = row
        self.spec = row["sqlite"]
        self.path = path
        self.conn = open_read_only(path)
        self.conn.row_factory = sqlite3.Row
        have = _columns(self.conn, self.spec["optional_columns"]["table"])
        self.have = have
        self.optional = [c for c in self.spec["optional_columns"]["columns"] if c in have]
        alias = self.spec["optional_columns"]["alias"]
        self.fragment = "".join(f", {alias}.{c} AS {c}" for c in self.optional)
        self.scope = Scope(path)

    def close(self):
        self.conn.close()

    def rows(self, name, params=()):
        query = self.spec["queries"][name]
        needs = query.get("requires_columns") or []
        if any(column not in self.have for column in needs):
            return []
        text = query["sql"]
        for column, fragment in (query.get("when_column") or {}).items():
            text = text.replace("{" + column + "}", fragment if column in self.have else "")
        return [dict(r) for r in self.conn.execute(_sql(text, self.fragment), params).fetchall()]

    def message(self, row, index):
        return sqlite_message(self.row, row, index)

    def reaction(self, row):
        return sqlite_reaction(self.row, row)


def sqlite_message(source_row, record, index):
    """One query record -> a normalized mapper message spec, by the source row's
    `sqlite.message` rule and lifecycle (`state_events`) rules. Needs no database."""
    spec_rule = source_row["sqlite"]
    scope = Scope().with_(message=record)
    spec = _message_spec({"message": spec_rule["message"]}, scope, index)
    spec["state_events"] = _state_events(spec_rule.get("state_events", []), record, Scope()) \
        if holds(spec_rule.get("state_events_when"), scope, "message") else []
    spec["relations"] = []
    return spec


def sqlite_reaction(source_row, record):
    """One reaction query record -> a normalized mapper reaction spec, by the
    source row's `sqlite.reaction` rule. Needs no database."""
    rule = source_row["sqlite"]["reaction"]
    scope = Scope().with_(message=record)
    symbol = value(rule["symbol"], scope, "message")
    at = value(rule["at"], scope, "message")
    return {
        "native_ref": str(value(rule["native_ref"], scope, "message")),
        "speaker": value(rule["speaker"], scope, "message"),
        "text": None,
        "at": at,
        "kind": "reaction",
        "reaction_symbol": symbol,
        "reaction_kind": value(rule["reaction_kind"], scope, "message"),
        "state_events": [{"key": f"reaction:{symbol}", "at": at, "provenance": 10,
                          "raw": value(rule["raw"], scope, "message")}],
        "relations": [{"role": "reaction_target",
                       "target_native_ref": value(rule["target"], scope, "message")}],
    }


def _rows_value(spec_rule, row, scope):
    return value(spec_rule, scope.with_(message=row), "message")


def decode_sqlite(observation, row, descriptor):
    source_ref = observation["source_ref"]
    spec = row["sqlite"]
    try:
        db = SqliteSource(row, observation["native_ref"])
    except sqlite3.Error as error:
        return {"threads": [], "atoms": [], "rejections": [_rejection(
            source_ref, "native_ref", spec["unreadable_expected"], str(error))]}
    try:
        try:
            rows = db.rows("messages")
        except sqlite3.Error as error:
            return {"threads": [], "atoms": [], "rejections": [_rejection(
                source_ref, "schema", spec["schema_expected"], str(error))]}
        reactions = {}
        try:
            for r in db.rows("reactions"):
                reactions.setdefault(r[spec["thread_key"]], []).append(db.reaction(r))
        except sqlite3.Error:
            reactions = {}
    finally:
        db.close()
    chats = {}
    for r in rows:
        chats.setdefault(r[spec["thread_key"]], []).append(r)
    for key in reactions:
        chats.setdefault(key, [])
    specs = []
    for key, msgs in chats.items():
        thread_scope = db.scope.with_(values={"thread_key": key})
        session_id = str(_rows_value(spec["thread"]["id"], msgs[0], thread_scope) if msgs
                         else spec["thread"]["id_without_rows"].replace("{key}", str(key)))
        counterparties = {_rows_value(spec["thread"]["counterparty"], r, db.scope) for r in msgs}
        counterparties.discard(None)
        messages = [db.message(r, index) for index, r in enumerate(msgs)]
        title = (_rows_value(spec["thread"]["title"], msgs[0], db.scope) if msgs else None) or session_id
        thread = {"session_id": session_id, "title": title,
                  "messages": messages + reactions.get(key, [])}
        if len(counterparties) == 1:
            thread["send_ref"] = next(iter(counterparties))
        specs.append(thread)
    return tm.map_transcript(observation, descriptor, specs)


def decode_sqlite_summary(observation, row, descriptor, tail=6):
    """BOUNDED list projection: per thread ONE grouped stats set plus only the
    newest `tail` bodied messages, handing the mapper a spec that DECLARES the
    whole-thread totals as data (total_count / started_at / last_activity_at)
    while carrying only the tail. O(threads x tail), never O(all messages).
    session_id is identical to decode()'s, so a listed thread still opens through
    decode_sqlite_window. Reactions carry no body and are left to the full read."""
    source_ref = observation["source_ref"]
    spec = row["sqlite"]
    try:
        db = SqliteSource(row, observation["native_ref"])
    except sqlite3.Error as error:
        return {"threads": [], "atoms": [], "rejections": [_rejection(
            source_ref, "native_ref", spec["unreadable_expected"], str(error))]}
    limit = tail if isinstance(tail, int) and tail > 0 else 6
    try:
        try:
            rows = db.rows("summary_rows", (limit,))
        except sqlite3.Error:
            db.close()
            return decode_sqlite(observation, row, descriptor)
        send_by = {}
        try:
            for s in db.rows("summary_send"):
                if s["nh"] == 1 and s["one_handle"]:
                    send_by[s[spec["thread_key"]]] = s["one_handle"]
        except sqlite3.Error:
            send_by = {}
        stats = {}
        try:
            for s in db.rows("summary_stats"):
                stats[s[spec["thread_key"]]] = (s["total"], s["first_date"], s["last_date"])
        except sqlite3.Error:
            stats = {}
    finally:
        db.close()
    chats = {}
    for r in rows:
        chats.setdefault(r[spec["thread_key"]], []).append(r)
    time_rule = spec["thread"]["time"]
    specs = []
    for key, msgs in chats.items():
        stat = stats.get(key)
        total = (stat[0] if stat else None) or len(msgs)
        first_date = stat[1] if stat else msgs[0]["date"]
        last_date = stat[2] if stat else msgs[-1]["date"]
        base = max(0, int(total) - len(msgs))
        session_id = str(_rows_value(spec["thread"]["id"], msgs[0], db.scope)
                         or spec["thread"]["id_without_rows"].replace("{key}", str(key)))
        thread = {
            "session_id": session_id,
            "title": _rows_value(spec["thread"]["title"], msgs[0], db.scope) or session_id,
            "messages": [db.message(r, base + offset) for offset, r in enumerate(msgs)],
            "total_count": int(total),
            "started_at": _time(first_date, time_rule),
            "last_activity_at": _time(last_date, time_rule),
        }
        if send_by.get(key):
            thread["send_ref"] = send_by[key]
        specs.append(thread)
    return tm.map_transcript(observation, descriptor, specs)


def decode_sqlite_window(observation, row, descriptor, before_cursor=None, limit=256, session_id=None):
    """Bounded page via SQL: ONLY the requested thread and ONLY one page of rows
    (LIMIT/OFFSET). The cursor is the row index where the page begins."""
    empty = _empty_window(descriptor, session_id)
    if not session_id:
        return empty
    spec = row["sqlite"]
    try:
        db = SqliteSource(row, observation["native_ref"])
    except sqlite3.Error:
        return empty
    try:
        chat = db.rows("window_thread", (session_id,))
        fallback = spec["thread"].get("id_fallback_prefix")
        if not chat and fallback and session_id.startswith(fallback):
            chat = db.rows("window_thread_by_key", (session_id[len(fallback):],))
        if not chat:
            return empty
        key, title = chat[0]["key"], chat[0]["title"] or session_id
        total = db.rows("window_count", (key,))[0]["total"]
        end = total if before_cursor is None else max(0, min(int(before_cursor), total))
        start = max(0, end - limit)
        rows = db.rows("window_rows", (key, end - start, start))
        reactions = [db.reaction(r) for r in db.rows("window_reactions", (key,))]
    except sqlite3.Error:
        return empty
    finally:
        db.close()
    page = [db.message(r, start + offset) for offset, r in enumerate(rows)]
    return tm.map_page(observation, descriptor, session_id, title, page + reactions, start, total)


# ---------------------------------------------------------------------------
# The decoder contract: decode, window, summary page.
# ---------------------------------------------------------------------------
def _empty_window(descriptor, session_id):
    return {"atoms": [], "older_cursor": None, "has_older": False, "has_newer": False,
            "total_count": None, "session_id": session_id, "started_at": None,
            "last_activity_at": None, "title": session_id,
            "mark_ref": (descriptor or {}).get("display_mark_ref")}


def _specs_or_rejection(observation, row, descriptor=None):
    """(thread specs, rejections, snapshot) of the observation's file, or (None, [one rejection], None)."""
    source_ref = observation.get("source_ref")
    native_ref = observation.get("native_ref")
    expected = row.get("unreadable_expected", "readable file")
    if not isinstance(native_ref, str) or not native_ref:
        return None, [_rejection(source_ref, "native_ref", expected, "missing")], None
    try:
        specs, rejections, snapshot = thread_specs(row, native_ref, descriptor, observation)
    except (OSError, ValueError) as error:
        return None, [_rejection(source_ref, "native_ref", expected, str(error))], None
    if specs is None:
        rejection = dict(rejections)
        rejection["source_ref"] = source_ref
        return None, [rejection], None
    for rejection in rejections:
        rejection["source_ref"] = source_ref
    return specs, rejections, snapshot


def _cursor_of(row, snapshot):
    """{"next_cursor": ...} for a source whose pages carry their own cursor (mail pages), else nothing."""
    reader = spec_reader(row)
    if reader is not None and hasattr(reader, "next_cursor"):
        return {"next_cursor": reader.next_cursor(row, snapshot)}
    return {}


def decode(observation, row, descriptor=None):
    """One snapshot -> canonical {threads, atoms, rejections} (and the page's own `next_cursor` where it has one)."""
    if row.get("reader") == "sqlite-rows":
        return decode_sqlite(observation, row, descriptor)
    specs, rejections, snapshot = _specs_or_rejection(observation, row, descriptor)
    if specs is None:
        return {"threads": [], "atoms": [], "rejections": rejections, **_cursor_of(row, None)}
    result = tm.map_transcript(observation, descriptor, specs)
    result["rejections"] = rejections + result.get("rejections", [])
    result.update(_cursor_of(row, snapshot))
    return result


def decode_window(observation, row, descriptor=None, before_cursor=None, limit=256, session_id=None):
    """Bounded transcript page for ONE thread. A file snapshot is already on
    disk, so the page is an in-memory slice; the mapper derives the window
    metadata (cursor, has_older, has_newer). A thread not named (or a file that
    holds one thread) pages its only thread."""
    if row.get("reader") == "sqlite-rows":
        return decode_sqlite_window(observation, row, descriptor, before_cursor, limit, session_id)
    reader = spec_reader(row)
    if reader is not None and hasattr(reader, "decode_window"):
        return reader.decode_window(observation, row, descriptor, before_cursor, limit, session_id)
    empty = _empty_window(descriptor, session_id)
    try:
        specs, _, _ = thread_specs(row, observation["native_ref"], descriptor, observation)
    except (OSError, ValueError, KeyError):
        return empty
    if not specs:
        return empty
    target = next((s for s in specs if s["session_id"] == str(session_id)), None)
    if target is None:
        if not row.get("window_any_thread"):
            return empty
        target = specs[0]
    messages = target["messages"]
    total = len(messages)
    end = total if before_cursor is None else max(0, min(int(before_cursor), total))
    start = max(0, end - int(limit))
    return tm.map_page(observation, descriptor, target["session_id"], target["title"],
                       messages[start:end], start, total)


def decode_summary_page(observation, row, descriptor=None, cursor=None, limit=8):
    """One bounded page of threads. The row's `summary` says the order: newest
    first by last activity, or the source's own order. The cursor is an opaque
    non-negative offset owned by this reader."""
    source_ref = observation.get("source_ref")
    rule = row.get("summary") or {"order": "newest-first", "most": 64}
    if isinstance(cursor, bool) or (cursor is not None and not isinstance(cursor, int)) or (cursor or 0) < 0:
        return {"threads": [], "atoms": [], "rejections": [_rejection(
            source_ref, "cursor", "non-negative integer", repr(cursor))], "next_cursor": None, "has_more": False}
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > rule.get("most", 64):
        return {"threads": [], "atoms": [], "rejections": [_rejection(
            source_ref, "limit", f"integer from 1 through {rule.get('most', 64)}", repr(limit))],
            "next_cursor": None, "has_more": False}
    start = cursor or 0
    if rule["order"] == "source":
        specs, rejections, _ = _specs_or_rejection(observation, row, descriptor)
        if specs is None:
            return {"threads": [], "atoms": [], "rejections": rejections, "next_cursor": None, "has_more": False}
        selected = specs[start:start + limit]
        result = tm.map_transcript(observation, descriptor, selected)
        end = start + len(selected)
        result["has_more"] = end < len(specs)
        result["next_cursor"] = end if result["has_more"] else None
        result["rejections"] = rejections + result["rejections"]
        return result
    decoded = decode(observation, row, descriptor)
    threads = sorted(decoded.get("threads", []), key=lambda t: (
        str(t.get("last_activity_at") or t.get("started_at") or ""), str(t.get("thread_ref") or "")), reverse=True)
    if start > len(threads):
        return {"threads": [], "atoms": [], "rejections": [_rejection(
            source_ref, "cursor", "at most the thread count", start)], "next_cursor": None, "has_more": False}
    selected = threads[start:start + limit]
    refs = {t["thread_ref"] for t in selected}
    end = start + len(selected)
    has_more = end < len(threads)
    return {"threads": selected, "atoms": [a for a in decoded.get("atoms", []) if a["thread_ref"] in refs],
            "next_cursor": end if has_more else None, "has_more": has_more,
            "rejections": decoded.get("rejections", [])}


def decode_batch(request, row):
    """Several snapshots of one source, one bounded page. `request` carries the
    observations (`observation`, or `batch.accepted`), an optional `category_key`,
    a string `cursor`, a `limit` and the `descriptor`. The row's `batch.category`
    getter names, per snapshot, which category it holds (its default included): a
    snapshot of another category is skipped. Threads repeat across snapshots by
    thread id and are kept once, the first seen (snapshots read in `native_ref`
    order). Each thread is mapped alone, so a page never splits one. Any failure
    to read the request or a snapshot is one {"error": ...}, never an exception."""
    observations = [request["observation"]] if "observation" in request else (request.get("batch") or {}).get("accepted", [])
    if not isinstance(observations, list) or not observations:
        return {"error": "no observations in request"}
    try:
        cursor = int(request.get("cursor") or 0)
        limit = int(request.get("limit") or 100)
        if cursor < 0 or limit < 1:
            raise ValueError("negative cursor or empty page")
    except (TypeError, ValueError):
        return {"error": "invalid cursor or limit"}
    category = request.get("category_key")
    category_rule = (row.get("batch") or {}).get("category")
    entries, seen = [], set()
    for observation in sorted(observations, key=lambda o: str(o.get("native_ref", "")) if isinstance(o, dict) else ""):
        native_ref = observation.get("native_ref") if isinstance(observation, dict) else None
        if not isinstance(native_ref, str) or not native_ref:
            return {"error": "observation has no native_ref"}
        try:
            specs, rejection, snapshot = thread_specs(row, native_ref, request.get("descriptor"), observation)
        except (OSError, ValueError) as error:
            return {"error": f"snapshot read failed: {error}"}
        if specs is None:
            return {"error": f"snapshot not readable: expected {rejection['expected']}"}
        if category and category_rule and value(category_rule, Scope(native_ref, snapshot=snapshot), "snapshot") != category:
            continue
        for spec in specs:
            if spec["session_id"] not in seen:
                seen.add(spec["session_id"])
                entries.append((observation, spec))
    selected = entries[cursor:cursor + limit]
    result = {"threads": [], "atoms": [], "rejections": []}
    for observation, spec in selected:
        mapped = tm.map_transcript(observation, request.get("descriptor"), [spec])
        for key in result:
            result[key].extend(mapped.get(key, []))
    end = cursor + len(selected)
    result["next_cursor"] = str(end) if end < len(entries) else None
    result["count"] = len(result["atoms"])
    return result
