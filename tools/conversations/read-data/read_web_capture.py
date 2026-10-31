#!/usr/bin/env python3
# tools/conversations/read-data/read_web_capture.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# The reader for ONE captured page of a person's web AI conversations (a chat assistant's website, read while they
# were signed in to it), as a capture tool wrote it to a file. A row of read-data/sources.json with
# `reader: "web-capture"` names this reader. It never opens a browser, reads a profile, a cookie or a token, calls a
# provider, or sends a message: it reads the immutable file it is handed and normalizes it for the one mapper
# (transcript_mapper.py), which alone owns atom identity, thread and speaker references and presentation.
#
# The file is an `authenticated-web-conversation-page`:
#
#   {kind, provider, revision, capture_binding: {<the row's binding fields>}, capture_state: {status},
#    complete, retry_cursor?, page: {request_cursor, next_cursor, has_more},
#    conversations: [{id, revision, title?, updated_at?, deleted?, total_message_count,
#                     message_page: {request_cursor, next_cursor, has_more},
#                     messages: [{id, revision, position, role, text, created_at?, edited_at?, deleted?,
#                                 deleted_at?}]}]}
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. A page is atomic. Anything short of a complete, active, consistent capture (signed out, session expired, rate
#    limited, partial, a duplicate id or position, a cursor that disagrees with its `has_more`, a page over the
#    caller's limit, an output over the ceiling) is ONE typed rejection, no rows, and a cursor that does not
#    advance. A typed rejection carries its retry cursor or retry time so the caller can resume.
# 2. The provider the file names must be the provider the run expects (`descriptor.expected_provider`), and the
#    capture must carry the binding fields the row names (`captured_by`, `surface`, `authorization`: who captured
#    it, on what isolated surface, under what grant): a page that cannot say where it came from is refused. The
#    values are opaque; this reader checks they are present.
# 3. Message ids and provider content revisions are exact. A stable provider message id is a stable atom identity;
#    a changed provider revision changes the atom's content without making a duplicate. An edited or deleted
#    message keeps its place and carries the event (`edited`, `retracted`); a deleted conversation with no messages
#    leaves one lifecycle tombstone, so a deletion never silently disappears.
# 4. Cursors are opaque. A thread's message page is addressed by a cursor this reader makes from the conversation
#    id and the provider's own cursor; the caller passes it back unread.
# 5. Bounds: a file at most 8 MiB, a page at most 64 conversations, a conversation page at most 2,048 messages, the
#    encoded output at most 1 MiB. A page over a bound is refused, never cut.
#
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
from __future__ import annotations

import base64
import json
import pathlib
import re

import transcript_mapper as tm

MAX_CAPTURE_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_CONVERSATIONS = 64
MAX_MESSAGES_PER_CONVERSATION = 2048
REVISION = re.compile(r"^(?:1f|sha256):[0-9a-f]{64}$")
ROLES = {"user", "assistant", "system", "tool"}
ERROR_STATES = {"logged_out", "session_expired", "rate_limited"}
INVALID = "reason:invalid-web-conversation-snapshot"


class SnapshotError(ValueError):
    def __init__(self, reason_ref, path, expected, got, **details):
        super().__init__(reason_ref)
        self.reason_ref, self.path, self.expected, self.got, self.details = reason_ref, path, expected, got, details


def _nonempty(value, path, max_length=4096):
    if not isinstance(value, str) or not value or len(value) > max_length:
        raise SnapshotError(INVALID, path, f"non-empty string no longer than {max_length}", type(value).__name__)
    return value


def _revision(value, path):
    value = _nonempty(value, path, 71)
    if not REVISION.fullmatch(value):
        raise SnapshotError(INVALID, path, "canonical 1f:/sha256: lowercase 64-hex revision", value)
    return value


def _cursor(value, path):
    return None if value is None else _nonempty(value, path, 4096)


def _bounded_read(path_text):
    with pathlib.Path(path_text).open("rb") as source:
        raw = source.read(MAX_CAPTURE_BYTES + 1)
    if len(raw) > MAX_CAPTURE_BYTES:
        raise SnapshotError("reason:web-conversation-capture-too-large", "native_ref",
                            f"at most {MAX_CAPTURE_BYTES} bytes", len(raw))
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SnapshotError(INVALID, "native_ref", "UTF-8 JSON object", str(error)) from error


def _page(value, path):
    if not isinstance(value, dict):
        raise SnapshotError(INVALID, path, "object", type(value).__name__)
    request_cursor = _cursor(value.get("request_cursor"), f"{path}.request_cursor")
    next_cursor = _cursor(value.get("next_cursor"), f"{path}.next_cursor")
    has_more = value.get("has_more")
    if not isinstance(has_more, bool):
        raise SnapshotError(INVALID, f"{path}.has_more", "boolean", repr(has_more))
    if has_more != (next_cursor is not None):
        raise SnapshotError(INVALID, path, "has_more true exactly when next_cursor is present",
                            "inconsistent opaque cursor presence")
    return {"request_cursor": request_cursor, "next_cursor": next_cursor, "has_more": has_more}


def _state_event(kind, at, revision):
    return {"key": kind, "at": at, "provenance": 10, "source_revision": revision}


def _message_page_cursor(conversation_id, provider_cursor):
    value = json.dumps({"conversation_id": conversation_id, "provider_cursor": provider_cursor},
                       ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "message-page:" + base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode_message_page_cursor(value):
    if not isinstance(value, str) or not value.startswith("message-page:"):
        raise SnapshotError("reason:invalid-web-message-page-cursor", "cursor",
                            "opaque message-page cursor returned by this reader", "other cursor")
    encoded = value.split(":", 1)[1]
    try:
        decoded = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SnapshotError("reason:invalid-web-message-page-cursor", "cursor",
                            "valid opaque message-page cursor", "malformed") from error
    if not isinstance(decoded, dict) or set(decoded) != {"conversation_id", "provider_cursor"}:
        raise SnapshotError("reason:invalid-web-message-page-cursor", "cursor",
                            "exact conversation_id/provider_cursor cursor", "wrong shape")
    return (_nonempty(decoded.get("conversation_id"), "cursor.conversation_id", 1024),
            _cursor(decoded.get("provider_cursor"), "cursor.provider_cursor"))


def _optional_time(value, path):
    return None if value is None else _nonempty(value, path, 128)


def _message(message, conversation_id, index):
    path = f"conversations[{conversation_id}].messages[{index}]"
    if not isinstance(message, dict):
        raise SnapshotError(INVALID, path, "object", type(message).__name__)
    message_id = _nonempty(message.get("id"), f"{path}.id", 1024)
    revision = _revision(message.get("revision"), f"{path}.revision")
    role = message.get("role")
    if role not in ROLES:
        raise SnapshotError(INVALID, f"{path}.role", sorted(ROLES), repr(role))
    position = message.get("position")
    if isinstance(position, bool) or not isinstance(position, int) or position < 0:
        raise SnapshotError(INVALID, f"{path}.position", "non-negative integer", repr(position))
    deleted = message.get("deleted", False)
    if not isinstance(deleted, bool):
        raise SnapshotError(INVALID, f"{path}.deleted", "boolean", repr(deleted))
    text = message.get("text")
    if deleted:
        if text not in (None, ""):
            raise SnapshotError("reason:deleted-web-message-retained-content", f"{path}.text",
                                "null or empty for a deleted message", "non-empty")
        text = None
    elif not isinstance(text, str) or not text.strip():
        raise SnapshotError(INVALID, f"{path}.text", "non-empty string", repr(text))
    created_at = _optional_time(message.get("created_at"), f"{path}.created_at")
    edited_at = _optional_time(message.get("edited_at"), f"{path}.edited_at")
    deleted_at = _optional_time(message.get("deleted_at"), f"{path}.deleted_at")
    events = []
    if edited_at:
        events.append(_state_event("edited", edited_at, revision))
    if deleted:
        events.append(_state_event("retracted", deleted_at or edited_at or created_at, revision))
    return {"index": position, "native_ref": message_id, "speaker": role, "text": text,
            "at": edited_at or created_at, "kind": "utterance", "state_events": events, "_source_revision": revision}


def _conversation(conversation, index):
    path = f"conversations[{index}]"
    if not isinstance(conversation, dict):
        raise SnapshotError(INVALID, path, "object", type(conversation).__name__)
    conversation_id = _nonempty(conversation.get("id"), f"{path}.id", 1024)
    revision = _revision(conversation.get("revision"), f"{path}.revision")
    deleted = conversation.get("deleted", False)
    if not isinstance(deleted, bool):
        raise SnapshotError(INVALID, f"{path}.deleted", "boolean", repr(deleted))
    messages = conversation.get("messages")
    if not isinstance(messages, list) or len(messages) > MAX_MESSAGES_PER_CONVERSATION:
        raise SnapshotError(INVALID, f"{path}.messages",
                            f"list with at most {MAX_MESSAGES_PER_CONVERSATION} entries", type(messages).__name__)
    normalized = [_message(message, conversation_id, i) for i, message in enumerate(messages)]
    ids = [message["native_ref"] for message in normalized]
    positions = [message["index"] for message in normalized]
    if len(ids) != len(set(ids)):
        raise SnapshotError("reason:duplicate-web-message-id", f"{path}.messages", "unique message ids",
                            f"{len(ids) - len(set(ids))} duplicate(s)")
    if len(positions) != len(set(positions)):
        raise SnapshotError("reason:duplicate-web-message-position", f"{path}.messages", "unique positions",
                            f"{len(positions) - len(set(positions))} duplicate(s)")
    message_page = _page(conversation.get("message_page"), f"{path}.message_page")
    total_count = conversation.get("total_message_count")
    if isinstance(total_count, bool) or not isinstance(total_count, int) or total_count < len(normalized):
        raise SnapshotError(INVALID, f"{path}.total_message_count",
                            "non-negative integer not smaller than this page", repr(total_count))
    title = conversation.get("title")
    if title is not None:
        title = _nonempty(title, f"{path}.title", 2048)
    updated_at = _optional_time(conversation.get("updated_at"), f"{path}.updated_at")
    if deleted and not normalized:
        normalized.append({"index": 0, "native_ref": f"conversation-deletion:{conversation_id}", "speaker": "system",
                           "text": None, "at": updated_at, "kind": "utterance",
                           "state_events": [_state_event("retracted", updated_at, revision)],
                           "_source_revision": revision})
    return {"session_id": conversation_id, "title": title or conversation_id, "messages": normalized,
            "total_count": total_count, "last_activity_at": updated_at, "_source_revision": revision,
            "_deleted": deleted, "_message_page": message_page}


def _rejection(source_ref, error):
    value = {"source_ref": source_ref, "reason_ref": error.reason_ref, "violation_path": error.path,
             "expected": error.expected, "got": error.got}
    value.update(error.details)
    return value


def _empty(source_ref, error):
    return {"threads": [], "atoms": [], "rejections": [_rejection(source_ref, error)],
            "next_cursor": None, "has_more": False}


def _check_capture(snapshot, row, descriptor, source_ref):
    if not isinstance(snapshot, dict) or snapshot.get("kind") != "authenticated-web-conversation-page":
        raise SnapshotError(INVALID, "kind", "authenticated-web-conversation-page",
                            repr(snapshot.get("kind") if isinstance(snapshot, dict) else None))
    provider = _nonempty(snapshot.get("provider"), "provider", 256)
    expected = _nonempty((descriptor or {}).get("expected_provider"), "descriptor.expected_provider", 256)
    if provider != expected:
        raise SnapshotError("reason:web-conversation-provider-mismatch", "provider", expected, repr(provider))
    expected_source = (descriptor or {}).get("source_ref")
    if expected_source is not None and source_ref != expected_source:
        raise SnapshotError("reason:web-conversation-source-mismatch", "observation.source_ref",
                            expected_source, repr(source_ref))
    _revision(snapshot.get("revision"), "revision")
    binding = snapshot.get("capture_binding")
    if not isinstance(binding, dict):
        raise SnapshotError("reason:missing-authenticated-surface-binding", "capture_binding", "object",
                            type(binding).__name__)
    for field in row["web_capture"]["binding_fields"]:
        _nonempty(binding.get(field), f"capture_binding.{field}", 4096)
    state = snapshot.get("capture_state")
    if not isinstance(state, dict):
        raise SnapshotError(INVALID, "capture_state", "object", type(state).__name__)
    status = state.get("status")
    if status in ERROR_STATES:
        details = {}
        if status == "rate_limited" and state.get("retry_after") is not None:
            details["retry_after"] = _nonempty(state.get("retry_after"), "capture_state.retry_after", 128)
        raise SnapshotError(f"reason:web-conversation-{status.replace('_', '-')}", "capture_state.status",
                            "active", status, **details)
    if status != "active":
        raise SnapshotError(INVALID, "capture_state.status", "active", repr(status))


def decode(observation, row, descriptor=None, request_cursor=None, limit=50, category_key="threads"):
    """One captured page -> {threads, atoms, rejections, next_cursor, has_more, snapshot_revision}. With
    `category_key: "messages"` and a cursor this reader made, one conversation's page of messages."""
    source_ref = observation.get("source_ref") if isinstance(observation, dict) else None
    try:
        if not isinstance(observation, dict):
            raise SnapshotError("reason:invalid-web-conversation-request", "observation", "object",
                                type(observation).__name__)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_CONVERSATIONS:
            raise SnapshotError("reason:invalid-web-conversation-request", "limit", "integer from 1 through 64",
                                repr(limit))
        snapshot = _bounded_read(observation["native_ref"])
        _check_capture(snapshot, row, descriptor, source_ref)
        page = _page(snapshot.get("page"), "page")
        message_request = category_key == "messages"
        requested_conversation_id = requested_provider_cursor = None
        if message_request:
            requested_conversation_id, requested_provider_cursor = _decode_message_page_cursor(request_cursor)
        elif page["request_cursor"] != request_cursor:
            raise SnapshotError("reason:web-conversation-cursor-mismatch", "page.request_cursor",
                                "same opaque cursor supplied by the caller", "different opaque cursor")
        if snapshot.get("complete") is not True:
            raise SnapshotError("reason:web-conversation-partial-capture", "complete", "true",
                                repr(snapshot.get("complete")),
                                retry_cursor=_cursor(snapshot.get("retry_cursor"), "retry_cursor"))
        conversations = snapshot.get("conversations")
        if not isinstance(conversations, list) or (not message_request and len(conversations) > limit):
            raise SnapshotError("reason:web-conversation-page-over-limit", "conversations",
                                f"list with at most requested limit {limit}",
                                len(conversations) if isinstance(conversations, list) else type(conversations).__name__)
        specs = [_conversation(item, i) for i, item in enumerate(conversations)]
        ids = [spec["session_id"] for spec in specs]
        if len(ids) != len(set(ids)):
            raise SnapshotError("reason:duplicate-web-conversation-id", "conversations", "unique conversation ids",
                                f"{len(ids) - len(set(ids))} duplicate(s)")
        if message_request:
            specs = [spec for spec in specs if spec["session_id"] == requested_conversation_id]
            if len(specs) != 1:
                raise SnapshotError("reason:web-message-page-conversation-mismatch", "cursor.conversation_id",
                                    "one conversation matching the opaque cursor", "no exact match")
            if specs[0]["_message_page"]["request_cursor"] != requested_provider_cursor:
                raise SnapshotError("reason:web-message-page-cursor-mismatch", "message_page.request_cursor",
                                    "same provider cursor bound into the opaque cursor", "different cursor")
            if len(specs[0]["messages"]) > limit:
                raise SnapshotError("reason:web-conversation-page-over-limit", "conversation.messages",
                                    f"at most requested limit {limit}", len(specs[0]["messages"]))
        mapped = tm.map_transcript(observation, descriptor, specs)
        if mapped.get("rejections"):
            return {**mapped, "next_cursor": None, "has_more": False}
        by_key = {(f"thread:{source_ref}:{spec['session_id']}", message["native_ref"]): message
                  for spec in specs for message in spec["messages"]}
        by_id = {spec["session_id"]: spec for spec in specs}
        for atom in mapped["atoms"]:
            source = by_key.get((atom["thread_ref"], atom.get("native_ref")))
            if source:
                atom["source_content_revision"] = source["_source_revision"]
                atom["source_locator"] = [atom["thread_ref"], ["native", source["native_ref"]]]
        for thread in mapped["threads"]:
            spec = by_id[thread["session_id"]]
            thread["source_content_revision"] = spec["_source_revision"]
            provider_page = spec["_message_page"]
            thread["message_page"] = {
                "current_cursor": _message_page_cursor(spec["session_id"], provider_page["request_cursor"]),
                "next_cursor": (_message_page_cursor(spec["session_id"], provider_page["next_cursor"])
                                if provider_page["has_more"] else None),
                "has_more": provider_page["has_more"],
            }
            if spec["_deleted"]:
                thread["state_events"] = [_state_event("retracted", spec.get("last_activity_at"),
                                                       spec["_source_revision"])]
        if message_request:
            provider_page = specs[0]["_message_page"]
            mapped["next_cursor"] = (_message_page_cursor(specs[0]["session_id"], provider_page["next_cursor"])
                                     if provider_page["has_more"] else None)
            mapped["has_more"] = provider_page["has_more"]
        else:
            mapped["next_cursor"], mapped["has_more"] = page["next_cursor"], page["has_more"]
        mapped["snapshot_revision"] = snapshot["revision"]
        encoded = json.dumps(mapped, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_OUTPUT_BYTES:
            raise SnapshotError("reason:web-conversation-output-too-large", "decoder.output",
                                f"at most {MAX_OUTPUT_BYTES} bytes", len(encoded))
        return mapped
    except (KeyError, OSError, TypeError, SnapshotError) as error:
        if not isinstance(error, SnapshotError):
            error = SnapshotError(INVALID, "native_ref", "readable captured page", str(error))
        return _empty(source_ref, error)


def decode_request(request, row):
    """The request a caller makes for a page: exactly one captured file (`observation`, or `batch.accepted`), with
    the descriptor, an optional opaque `cursor`, `limit` and `category_key`. Several files at once are refused whole:
    one page is one capture, and two could not agree on one cursor."""
    descriptor = request.get("descriptor") or {}
    observations = ([request["observation"]] if "observation" in request
                    else (request.get("batch") or {}).get("accepted") or [])
    if len(observations) != 1:
        return {"threads": [], "atoms": [], "next_cursor": None, "has_more": False, "snapshot_revision": None,
                "rejections": [{"source_ref": None, "reason_ref": "reason:web-conversation-snapshot-count",
                                "violation_path": "observation", "expected": "exactly one captured file",
                                "got": len(observations)}]}
    result = decode(observations[0], row, descriptor, request_cursor=request.get("cursor"),
                    limit=request.get("limit", 50), category_key=request.get("category_key", "threads"))
    if result["rejections"]:
        return {"threads": [], "atoms": [], "rejections": result["rejections"], "next_cursor": None,
                "has_more": False, "snapshot_revision": None}
    return {"threads": result["threads"], "atoms": result["atoms"], "rejections": [],
            "next_cursor": result.get("next_cursor"), "has_more": result.get("has_more", False),
            "snapshot_revision": result.get("snapshot_revision")}
