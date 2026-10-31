#!/usr/bin/env python3
# tools/conversations/read-data/read_session_events.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# The ONE reader for the session logs an AI coding assistant keeps on its person's computer: JSON lines, one event
# per line, in two common shapes that this reader tells apart by what an event holds, never by which program wrote it:
#
#   flat response items   {timestamp, type, payload: {type: "message" | "function_call" | "function_call_output" |
#                          "reasoning" | ..., role, content, name, arguments, output, call_id, summary}}
#                          and {type: "event_msg", payload: {type: "user_message" | "agent_message", message}}
#   messages with blocks   {timestamp, uuid, message: {role, content: [{type: "text" | "tool_use" | "tool_result" |
#                          "thinking", ...}]}} and {type: "user" | "assistant", content}
#
# plus `status` and `error` events by shape. A row of read-data/sources.json with `reader: "session-events"` names
# this reader; the person says where their logs are (the file path), the reader never guesses a folder.
#
# One file is one thread. Its events become messages for the one mapper (transcript_mapper.py): an utterance, a
# thought, a tool call, a tool result, a status or an error, each a message `kind`. The mapper alone owns atom
# identity, thread and speaker references and presentation.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. NO NETWORK. A file is read where it lies. A line that is not a JSON object is skipped (a log being written
#    ends in half a line); an unreadable file is ONE structured rejection.
# 2. An atom's identity is its event's own id (`uuid`, `id`) and the block it is, else the byte offset of the event's
#    line and the block, else the BLAKE3 identity of the event itself. The same event gives the same atom whether the
#    file is read whole or from its tail, and a later edit of the file adds atoms without re-keying earlier ones.
# 3. A page from the TAIL of the file reads backward from a byte offset and stops once it holds enough: a
#    multi-gigabyte log opens at once, because the cost is the page, not the file.
# 4. An event whose shape this reader does not know is skipped, never guessed at (the blind-parser rule).
# 5. `origin_ref: "human-root-session"` is put on a user utterance only when the log's own `session_meta` event says
#    a person started the session (not a sub-agent it spawned); a sub-agent's or ambiguous session carries none.
#
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
from __future__ import annotations

import datetime
import json
import pathlib

import transcript_mapper as tm
from content_identity import content_hash
from read_source import block_text

TAIL_BLOCK_BYTES = 262144


def _cleaned(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def normalize_time(value):
    """A timestamp as the log wrote it: ISO text passes through, a number is epoch seconds or milliseconds."""
    if isinstance(value, str) and value:
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        try:
            return datetime.datetime.fromtimestamp(
                value / 1000 if value > 1e12 else value, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        except (OverflowError, OSError, ValueError):
            return None
    return None


def _first_present(*values):
    for value in values:
        cleaned = _cleaned(value)
        if cleaned:
            return cleaned
    return None


def _status_text(event, payload):
    return _first_present(event.get("status"), event.get("state"), event.get("phase"),
                          payload.get("status"), payload.get("state"), payload.get("phase"))


def _error_text(event, payload):
    error = event.get("error") if event.get("error") is not None else payload.get("error")
    if isinstance(error, str):
        return error
    if isinstance(error, dict):
        text = _first_present(error.get("message"), error.get("text"), error.get("reason"), error.get("code"))
        if text:
            return text
    return _first_present(event.get("error_message"), event.get("message"), payload.get("error_message"),
                          payload.get("message"))


def _message(kind, at, text, speaker, tool=None):
    spec = {"kind": kind, "speaker": speaker, "text": text, "at": at}
    if tool is not None:
        spec["tool"] = tool
    return spec


def _flat_payload(payload, at):
    """A flat response item that is a tool call, a tool result or a reasoning summary -> messages."""
    kind = payload.get("type")
    if kind == "function_call":
        try:
            tool_input = json.loads(payload.get("arguments") or "null")
        except (ValueError, TypeError):
            tool_input = payload.get("arguments")
        name = payload.get("name") or "tool"
        return [_message("tool-call", at, name, "assistant",
                         {"name": name, "input": tool_input, "call_ref": payload.get("call_id")})]
    if kind == "function_call_output":
        output = payload.get("output")
        text = output if isinstance(output, str) else block_text(output, "join")
        return [_message("tool-result", at, text, "assistant", {"call_ref": payload.get("call_id")})]
    summary = block_text(payload.get("summary"), "join")
    if isinstance(summary, str) and summary.strip():
        return [_message("thought", at, summary, "assistant")]
    return []


def _content_blocks(role, blocks, at, title_rule):
    """A content-block list -> (messages, title candidate). Each message knows the block it came from."""
    found, title = [], None
    for position, block in enumerate(blocks):
        before = len(found)
        if not isinstance(block, dict):
            if isinstance(block, str) and block.strip():
                found.append(_message("utterance", at, block, role))
        else:
            kind = block.get("type")
            if kind == "tool_use":
                name = block.get("name") or "tool"
                found.append(_message("tool-call", at, name, "assistant",
                                      {"name": name, "input": block.get("input"), "call_ref": block.get("id")}))
            elif kind == "tool_result":
                found.append(_message("tool-result", at, block_text(block.get("content"), "join"), "assistant",
                                      {"call_ref": block.get("tool_use_id")}))
            elif kind == "thinking":
                thought = block.get("thinking") or block.get("text")
                if isinstance(thought, str) and thought.strip():
                    found.append(_message("thought", at, thought, "assistant"))
            else:
                text = block.get("text") or block.get("content")
                if isinstance(text, str) and text.strip():
                    found.append(_message("utterance", at, text, role))
                    if title is None and role == "user" and _titled(text, title_rule):
                        title = text.strip()[:title_rule["max"]]
        for message in found[before:]:
            message["block"] = position
    return found, title


def _titled(text, title_rule):
    return not any(text.lstrip().startswith(prefix) for prefix in title_rule["skip_prefixes"])


def interpret_event(event, title_rule):
    """ONE parsed event -> (messages, title candidate). The single place that knows these event shapes, shared by the
    whole-file read and the tail read."""
    if not isinstance(event, dict):
        return [], None
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    message = event.get("message") if isinstance(event.get("message"), dict) else None
    at = normalize_time(event.get("timestamp") or payload.get("timestamp") or event.get("created_at")
                        or event.get("updated_at") or (message.get("timestamp") if message else None))
    if payload.get("type") in ("function_call", "function_call_output", "reasoning"):
        return _flat_payload(payload, at), None
    if event.get("type") == "error" or payload.get("type") == "error" or event.get("level") == "error":
        text = _error_text(event, payload)
        return ([_message("error", at, text, "system")] if text else []), None
    if event.get("type") == "status" or payload.get("type") == "status":
        text = _status_text(event, payload)
        return ([_message("status", at, text, "system")] if text else []), None

    role, content = None, None
    if message is not None:
        role, content = message.get("role"), message.get("content")
    if role is None and payload.get("type") == "message":
        role, content = payload.get("role"), payload.get("content")
    if role is None and event.get("type") in ("user", "assistant"):
        role = event.get("type")
        content = event.get("content") or payload.get("message")
    if event.get("type") == "event_msg" and payload.get("type") in ("user_message", "agent_message"):
        role = "user" if payload.get("type") == "user_message" else "assistant"
        content = payload.get("message")
    if role not in ("user", "assistant"):
        return [], None
    if isinstance(content, list):
        return _content_blocks(role, content, at, title_rule)
    text = block_text(content, "join")
    if not isinstance(text, str) or not text.strip():
        return [], None
    title = text.strip()[:title_rule["max"]] if role == "user" and _titled(text, title_rule) else None
    return [_message("utterance", at, text, role)], title


def _locator(event, line_offset):
    """The part of an atom's identity that is its event's: its own id, else where its line starts, else the event."""
    message = event.get("message") if isinstance(event.get("message"), dict) else {}
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    native = event.get("uuid") or event.get("id") or payload.get("id") or message.get("id")
    if native is not None:
        return f"native:{native}"
    if line_offset is not None:
        return f"byte-offset:{line_offset}"
    canonical = json.dumps(event, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return f"event-content:{content_hash(canonical)}"


def messages_of_event(event, line_offset, title_rule):
    """(mapper messages with their identity, title candidate) of one event."""
    found, title = interpret_event(event, title_rule)
    locator = _locator(event, line_offset) if found else None
    for position, message in enumerate(found):
        message["native_ref"] = f"{locator}:{message.pop('block', position)}"
    return found, title


def _title_rule(row):
    rule = (row.get("session_events") or {}).get("title") or {}
    return {"skip_prefixes": list(rule.get("skip_prefixes", ["<"])), "max": int(rule.get("max", tm.PREVIEW_CHARS))}


def _origin(events):
    """"human-root-session" when the log's `session_meta` says a person started the session (directly, or by forking
    an agent's thread), else None. A sub-agent's session, a fork of unknown parentage and a log without the event say
    nothing."""
    origin = None
    for event in events:
        if event.get("type") != "session_meta" or not isinstance(event.get("payload"), dict):
            continue
        meta = event["payload"]
        source = meta.get("thread_source")
        direct_root = source == "user" and not meta.get("forked_from_id")
        human_fork = (source == "agent_forked_thread" and isinstance(meta.get("forked_from_id"), str)
                      and bool(meta["forked_from_id"]))
        if (direct_root or human_fork) and not meta.get("parent_thread_id") and not isinstance(meta.get("source"), dict):
            origin = "human-root-session"
        elif source == "subagent" or meta.get("parent_thread_id") or meta.get("forked_from_id"):
            origin = None
    return origin


def _lines(path):
    """(byte offset of the line, parsed event) of every complete JSON-object line of the file, in order."""
    offset = 0
    with open(path, "rb") as handle:
        for raw in handle:
            start, offset = offset, offset + len(raw)
            line = raw.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict):
                yield start, event


def thread_specs(row, path, descriptor=None, observation=None):
    """The log at `path` -> ([one thread spec], [], None), or a rejection when the file cannot be read. One file is
    one thread whose id is the file's name without its suffix."""
    rule = _title_rule(row)
    try:
        events = list(_lines(path))
    except OSError as error:
        return None, {"violation_path": "native_ref", "expected": "readable", "got": str(error)}, None
    origin = _origin(event for _, event in events)
    messages, title = [], None
    for start, event in events:
        found, candidate = messages_of_event(event, start, rule)
        if title is None and candidate:
            title = candidate
        messages.extend(found)
    if origin:
        for message in messages:
            if message["kind"] == "utterance" and message["speaker"] == "user":
                message["origin_ref"] = origin
    for position, message in enumerate(messages):
        message["index"] = position
    session_id = pathlib.Path(path).stem
    spec = {"session_id": session_id, "title": title or session_id, "messages": messages,
            "total_count": sum(1 for message in messages if message["kind"] == "utterance")}
    return [spec], [], None


# ---------------------------------------------------------------------------
# Pages from the tail of the file.
# ---------------------------------------------------------------------------
def _complete_lines(region_start, data, end_offset, file_size):
    """Chronological [(line start offset, line bytes)] of the COMPLETE lines in file[region_start:end_offset]. A
    leading partial line (when region_start > 0) is discarded: the next older page re-reads it. The trailing piece
    after the last newline is a real, unterminated final line only when the region reaches the end of the file."""
    newlines = [index for index, byte in enumerate(data) if byte == 0x0A]
    lines, previous = [], (0 if region_start == 0 else (newlines[0] + 1 if newlines else len(data)))
    for index in (newlines if region_start == 0 else newlines[1:]):
        lines.append((region_start + previous, data[previous:index]))
        previous = index + 1
    if previous < len(data) and end_offset >= file_size:
        lines.append((region_start + previous, data[previous:]))
    return lines


def _read_back(path, end_offset, file_size, limit, rule):
    """(atoms-as-messages, the start offset of each message's line, the region start) holding at least `limit`
    messages ending at `end_offset`, or the whole file up to there."""
    block, region_start, data = TAIL_BLOCK_BYTES, end_offset, b""
    with open(path, "rb") as handle:
        while True:
            if region_start > 0:
                new_start = max(0, region_start - block)
                handle.seek(new_start)
                data = handle.read(region_start - new_start) + data
                region_start = new_start
            messages, starts = [], []
            for start, line in _complete_lines(region_start, data, end_offset, file_size):
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                found, _ = messages_of_event(event, start, rule)
                messages.extend(found)
                starts.extend([start] * len(found))
            if len(messages) > limit or region_start == 0:
                return messages, starts, region_start


def decode_window(observation, row, descriptor=None, before_cursor=None, limit=256, session_id=None):
    """A bounded page of the log, newest first from `before_cursor` (a byte offset; none = the end = the latest
    page). The cursor is the byte offset where the page began; the next older page passes it back. `total_count` is
    None: it is unknown without reading the whole file."""
    path = pathlib.Path(observation["native_ref"])
    source_ref = observation["source_ref"]
    stem = path.stem
    empty = {"atoms": [], "older_cursor": None, "has_older": False, "has_newer": False, "total_count": None,
             "session_id": stem, "started_at": None, "last_activity_at": None, "title": stem,
             "mark_ref": (descriptor or {}).get("display_mark_ref")}
    try:
        file_size = path.stat().st_size
        end_offset = file_size if before_cursor is None else max(0, min(int(before_cursor), file_size))
        messages, starts, _ = _read_back(path, end_offset, file_size, limit, _title_rule(row))
    except OSError:
        return empty
    if len(messages) > limit:
        boundary = len(messages) - limit
        while boundary > 0 and starts[boundary - 1] == starts[boundary]:
            boundary -= 1  # never split the messages of one event across two pages
        kept, kept_starts = messages[boundary:], starts[boundary:]
        older_cursor, has_older = kept_starts[0], kept_starts[0] > 0
    else:
        kept, older_cursor, has_older = messages, None, False
    for position, message in enumerate(kept):
        message["index"] = position
    page = tm.map_page({"source_ref": source_ref, "batch_ref": observation.get("batch_ref")}, descriptor, stem,
                       stem, kept, 0, len(kept))
    page.update({"older_cursor": older_cursor, "has_older": has_older, "has_newer": end_offset < file_size,
                 "total_count": None})
    return page
