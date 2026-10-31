#!/usr/bin/env python3
# tools/conversations/read-data/read_mail.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# The ONE reader for mail wires: what an email looks like as bytes or as a mail service's message resource. A row of
# read-data/sources.json with `reader: "mail"` names the wire in `mail.wire`:
#
#   rfc5322         one message file (.eml): headers, MIME parts, attachments (RFC 5322 / RFC 2045-2049)
#   mime-part-tree  a page of message resources as a mail service serves them: headers as [{name, value}] under
#                   `payload.headers`, the body in a tree of `payload.parts`, base64url body data, `internalDate` in
#                   epoch milliseconds, `labelIds`, and a `historyId` or `nextPageToken` for the next page
#
# It normalizes a snapshot into source-neutral `thread_specs` and hands them to the one mapper
# (transcript_mapper.py), which alone owns atom identity, thread and speaker references and presentation. Which of
# the person's addresses is "me" is the run's `mailbox_address` (the descriptor); the reader names no one.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. NO NETWORK, NO TOKEN. A page is fetched by whatever pulled it; this reads the file it left.
# 2. A corrupt part is a silent absence, a malformed message is ONE structured rejection that leaves the rest of its
#    page readable, an unreadable or oversized file is ONE structured rejection. Never an exception for the batch.
# 3. An attachment is a reference ({filename, mime, size, fetch_ref}, plus the BLAKE3 identity of its bytes for a
#    message file); its bytes are never carried. An HTML-only body is projected to text (script and style dropped),
#    never dropped.
# 4. A label is one self-describing state event `label:<id>`; no label is named here.
# 5. `send_ref` (where a reply goes) is set only when the thread has exactly one address other than the person's own;
#    a group thread fails closed.
#
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
from __future__ import annotations

import base64
import datetime
import html
import json
import pathlib
import re
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime

from content_identity import content_hash

HARD_MAX_MESSAGE_BYTES = 25 * 1024 * 1024
HARD_MAX_ATTACHMENT_COUNT = 100

_ADDRESS_IN_BRACKETS = re.compile(r"<([^<>@\s]+@[^<>@\s]+)>")
_BARE_ADDRESS = re.compile(r"([^<>@\s,;\"']+@[^<>@\s,;\"']+)")
_MESSAGE_ID = re.compile(r"<([^<>\s]+)>")
_TAG = re.compile(r"<[^>]+>")
_BLOCK_BREAK = re.compile(r"(?i)<\s*(?:br|/p|/div|/tr|/li|/h[1-6])[^>]*>")
_DROPPED_ELEMENT = re.compile(r"(?is)<\s*(script|style)[^>]*>.*?<\s*/\s*\1\s*>")


def html_to_text(markup):
    """Plaintext projection of an HTML-only body: drop script/style, turn block boundaries into newlines, strip
    tags, unescape entities, collapse blanks."""
    if not markup:
        return None
    text = _DROPPED_ELEMENT.sub("", markup)
    text = _BLOCK_BREAK.sub("\n", text)
    text = _TAG.sub("", text)
    text = html.unescape(text)
    lines = [" ".join(line.split()) for line in text.splitlines()]
    return "\n".join(line for line in lines if line) or None


def _rejection(path, expected, got):
    return {"violation_path": path, "expected": expected, "got": str(got)[:240]}


def _fatal(path, expected, got):
    return None, _rejection(path, expected, got), None


# ---------------------------------------------------------------------------
# The message-resource wire (a page of messages).
# ---------------------------------------------------------------------------
def _headers_of(message):
    """The headers of a message resource as a case-insensitive dict; the first of a repeated header wins."""
    found = {}
    for header in (message.get("payload") or {}).get("headers") or []:
        name = (header.get("name") or "").lower()
        if name and name not in found:
            found[name] = header.get("value") or ""
    return found


def _addresses_of(header_value):
    """Every mailbox address in a From/To/Cc value, lowercased. `Name <a@b>` and bare `a@b` both read; a display
    name is presentation, not addressing."""
    if not header_value:
        return []
    found = _ADDRESS_IN_BRACKETS.findall(header_value) or _BARE_ADDRESS.findall(header_value)
    return [address.strip().lower() for address in found if address.strip()]


def _internal_date_to_iso(value):
    """internalDate is epoch MILLISECONDS as a string. Uniform microsecond precision, because the mapper orders
    activity by LEXICAL ISO comparison."""
    try:
        millis = int(value)
    except (TypeError, ValueError):
        return None
    if millis <= 0:
        return None
    try:
        stamp = datetime.datetime.fromtimestamp(millis / 1000.0, datetime.timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    return stamp.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _base64url_text(data):
    """A base64url body chunk as text; None on any failure (a corrupt part is a silent absence)."""
    if not data:
        return None
    try:
        return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", errors="replace")
    except (ValueError, TypeError):
        return None


def _walk_parts(part, found):
    """Depth-first walk of a MIME part tree collecting {mime -> body text} and attachment descriptors; parts nest
    arbitrarily."""
    if not isinstance(part, dict):
        return
    mime = (part.get("mimeType") or "").lower()
    body = part.get("body") or {}
    filename = part.get("filename") or ""
    if filename and body.get("attachmentId"):
        found["attachments"].append({"filename": filename, "mime": mime, "size": body.get("size"),
                                     "fetch_ref": body["attachmentId"]})
    elif mime.startswith("text/") and body.get("data"):
        text = _base64url_text(body.get("data"))
        if text is not None and mime not in found["texts"]:
            found["texts"][mime] = text
    for child in part.get("parts") or []:
        _walk_parts(child, found)


def _body_and_attachments(message):
    """The renderable body of one message resource and its attachment descriptors: text/plain, else the projection
    of text/html, else None."""
    found = {"texts": {}, "attachments": []}
    _walk_parts(message.get("payload") or {}, found)
    text = found["texts"].get("text/plain")
    if text is None or not text.strip():
        text = html_to_text(found["texts"].get("text/html"))
    if text is not None and not text.strip():
        text = None
    return text, found["attachments"]


def _page_specs(snapshot, mailbox):
    """(thread specs, per-message rejections) of one page of message resources, one thread per `threadId`."""
    rejections, by_thread = [], {}
    for position, message in enumerate(snapshot.get("messages") or []):
        if not isinstance(message, dict) or not message.get("id"):
            rejections.append(_rejection(f"messages[{position}]", "message resource with id", repr(message)[:120]))
            continue
        by_thread.setdefault(str(message.get("threadId") or message["id"]), []).append(message)

    def internal_date(message):
        try:
            return int(message.get("internalDate") or 0)
        except (TypeError, ValueError):
            return 0

    specs = []
    for thread_id, messages in by_thread.items():
        utterances, counterparties, title = [], set(), None
        for index, message in enumerate(sorted(messages, key=internal_date)):
            headers = _headers_of(message)
            if title is None and headers.get("subject"):
                title = headers["subject"]
            senders = _addresses_of(headers.get("from"))
            sender = senders[0] if senders else None
            is_mine = bool(mailbox) and sender == mailbox
            for address in senders + _addresses_of(headers.get("to")) + _addresses_of(headers.get("cc")):
                if address and address != mailbox:
                    counterparties.add(address)
            text, attachments = _body_and_attachments(message)
            utterances.append({
                "index": index,
                "native_ref": str(message["id"]),
                "speaker": "me" if is_mine else (sender or "them"),
                "text": text,
                "at": _internal_date_to_iso(message.get("internalDate")),
                "kind": "utterance",
                "state_events": [{"key": f"label:{label}", "at": None, "provenance": 10, "raw": "labelIds"}
                                 for label in message.get("labelIds") or [] if label],
                "relations": [{"role": "attachment", "attachment_ref": attachment} for attachment in attachments],
            })
        spec = {"session_id": thread_id, "title": title or thread_id, "messages": utterances}
        if len(counterparties) == 1:
            spec["send_ref"] = next(iter(counterparties))
        specs.append(spec)
    return specs, rejections


# ---------------------------------------------------------------------------
# The message-file wire (one RFC 5322 message).
# ---------------------------------------------------------------------------
def _bounded(value, default, hard_max):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    if parsed <= 0:
        parsed = default
    return min(parsed, hard_max)


def _message_ids(value):
    if not value:
        return []
    found = _MESSAGE_ID.findall(str(value))
    if found:
        return [item.strip() for item in found if item.strip()]
    bare = str(value).strip().strip("<>")
    return [bare] if bare and not any(char.isspace() for char in bare) else []


def _header_addresses(message, names):
    values = []
    for name in names:
        values.extend(str(value) for value in message.get_all(name, []) if value)
    found = []
    for _display, address in getaddresses(values):
        normalized = address.strip().lower()
        if normalized and normalized not in found:
            found.append(normalized)
    return found


def _date_to_iso(value, fallback=None):
    if value:
        try:
            parsed = parsedate_to_datetime(str(value))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=datetime.timezone.utc)
            return parsed.astimezone(datetime.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
        except (TypeError, ValueError, OverflowError):
            pass
    return fallback if isinstance(fallback, str) and fallback.strip() else None


def _part_content(part):
    try:
        value = part.get_content()
    except (KeyError, LookupError, TypeError, ValueError, UnicodeError):
        payload = part.get_payload(decode=True)
        if payload is None:
            return None
        return payload.decode(part.get_content_charset() or "utf-8", errors="replace")
    if isinstance(value, bytes):
        return value.decode(part.get_content_charset() or "utf-8", errors="replace")
    return value if isinstance(value, str) else None


def _file_body(message):
    plain = markup = None
    for part in message.walk():
        if part.is_multipart() or part.is_attachment() or part.get_filename():
            continue
        content_type = part.get_content_type().lower()
        if content_type == "text/plain" and plain is None:
            plain = _part_content(part)
        elif content_type == "text/html" and markup is None:
            markup = _part_content(part)
    if plain is not None and plain.strip():
        return plain
    return html_to_text(markup)


def _file_attachments(message, most):
    found = []
    for index, part in enumerate(message.walk()):
        filename = part.get_filename()
        if not (part.is_attachment() or filename):
            continue
        if len(found) >= most:
            raise ValueError(f"attachment count exceeds {most}")
        payload = part.get_payload(decode=True) or b""
        digest = content_hash(payload)
        found.append({"filename": str(filename or f"part-{index}"), "mime": part.get_content_type().lower(),
                      "size": len(payload), "content_hash": digest, "fetch_ref": f"mime-part:{index}:{digest}"})
    return found


def _file_specs(path, descriptor, observation):
    """(thread specs, rejections, None) of one message file, or a fatal rejection."""
    mailbox = str(descriptor.get("mailbox_address") or "").strip().lower()
    if not mailbox:
        return _fatal("descriptor.mailbox_address", "non-empty mailbox address", "missing")
    most_bytes = _bounded(descriptor.get("max_message_bytes"), HARD_MAX_MESSAGE_BYTES, HARD_MAX_MESSAGE_BYTES)
    try:
        size = pathlib.Path(path).stat().st_size
        if size > most_bytes:
            return _fatal("message_bytes", f"at most {most_bytes}", size)
        raw = pathlib.Path(path).read_bytes()
    except OSError as error:
        return _fatal("native_ref", "readable RFC 5322 bytes", error)
    if len(raw) > most_bytes:
        return _fatal("message_bytes", f"at most {most_bytes}", len(raw))
    digest = content_hash(raw)
    try:
        message = BytesParser(policy=policy.default).parsebytes(raw)
    except (TypeError, ValueError, IndexError) as error:
        return _fatal("message", "parseable RFC 5322/MIME", error)
    if message.defects:
        return _fatal("message.defects", "well-formed RFC 5322/MIME",
                      ", ".join(type(item).__name__ for item in message.defects))

    ids = _message_ids(message.get("Message-ID"))
    message_id = ids[0] if ids else digest
    references = _message_ids(message.get("References"))
    in_reply_to = _message_ids(message.get("In-Reply-To"))
    thread_root = (references or in_reply_to or [message_id])[0]
    senders = _header_addresses(message, ["From"])
    sender = senders[0] if senders else "unknown"
    recipients = _header_addresses(message, ["To", "Cc", "Reply-To"])
    counterparties = {address for address in senders + recipients if address != mailbox}

    most_attachments = _bounded(descriptor.get("max_attachment_count"), HARD_MAX_ATTACHMENT_COUNT,
                                HARD_MAX_ATTACHMENT_COUNT)
    try:
        attachments = _file_attachments(message, most_attachments)
    except ValueError as error:
        return _fatal("message.attachments", f"at most {most_attachments}", error)

    observed_at = (observation or {}).get("observed_at")
    relations = [{"role": "mail_thread_headers", "message_id": message_id,
                  "in_reply_to": in_reply_to[0] if in_reply_to else None, "references": references}]
    relations.extend({"role": "attachment", "attachment_ref": attachment} for attachment in attachments)
    spec = {
        "session_id": thread_root,
        "title": str(message.get("Subject") or thread_root),
        "messages": [{
            "index": 0,
            "native_ref": message_id,
            "speaker": "me" if sender == mailbox else sender,
            "text": _file_body(message),
            "at": _date_to_iso(message.get("Date"), observed_at),
            "kind": "utterance",
            "state_events": [{"key": "mail:received", "at": observed_at, "provenance": 10, "raw": "rfc5322"}],
            "relations": relations,
        }],
    }
    if len(counterparties) == 1:
        spec["send_ref"] = next(iter(counterparties))
    return [spec], [], None


# ---------------------------------------------------------------------------
# The reader's entry: what read_source.py calls for a row with `reader: "mail"`.
# ---------------------------------------------------------------------------
def thread_specs(row, path, descriptor=None, observation=None):
    """The mail at `path` -> ([thread_spec], [rejection without source_ref], snapshot), or
    (None, one rejection, None) when nothing of it can be read. `snapshot` is the parsed page for the
    message-resource wire, None for a message file."""
    descriptor = descriptor or {}
    wire = (row.get("mail") or {}).get("wire")
    if wire == "rfc5322":
        return _file_specs(path, descriptor, observation)
    if wire != "mime-part-tree":
        raise ValueError(f"unknown mail wire {wire!r}")
    try:
        snapshot = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return _fatal("native_ref", row["unreadable_expected"], error)
    if not isinstance(snapshot, dict):
        return _fatal("page", "message page object", type(snapshot).__name__)
    if isinstance(snapshot.get("error"), dict):
        problem = snapshot["error"]
        return _fatal("page.error", "authorized message page",
                      f"{problem.get('status') or problem.get('code')}: {problem.get('message')}")
    specs, rejections = _page_specs(snapshot, str(descriptor.get("mailbox_address") or "").strip().lower())
    return specs, rejections, snapshot


def next_cursor(row, snapshot):
    """The page's own cursor (`historyId`, else `nextPageToken`) for whatever pulls the next page; None for a
    message file."""
    if (row.get("mail") or {}).get("wire") != "mime-part-tree" or not isinstance(snapshot, dict):
        return None
    return snapshot.get("historyId") or snapshot.get("nextPageToken") or None
