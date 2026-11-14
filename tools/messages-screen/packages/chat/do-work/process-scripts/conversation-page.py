#!/usr/bin/env python3
"""Build and read bounded immutable conversation-overflow page nodes.

The node chain retains only rows omitted by materializations after this contract
is installed. It is not an index and never reads a personal source. Each node is
an immutable CAS value pointing backward to the previously retained node.
"""

import json
import pathlib
import re
import sys


CANONICAL_HASH = re.compile(r"^1f:[0-9a-f]{64}$")
MAX_NODE_ROWS = 512
MAX_NODE_BYTES = 2 * 1024 * 1024
MAX_WINDOW_BYTES = 2 * 1024 * 1024
# The workflow transports this JSON inside a result envelope. Keep the raw page
# comfortably below the consumer's 2 MiB cross-realm byte ceiling so base64 and
# envelope fields cannot turn an accepted helper result into an oversized reply.
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_PAGE_LIMIT = 64
MAX_SAFE_INTEGER = 9007199254740991
PAGE_SCOPE = "future-retained-overflow-only"


def _canonical_hash(value, *, nullable=False):
    if nullable and value is None:
        return None
    if not isinstance(value, str) or CANONICAL_HASH.fullmatch(value) is None:
        raise ValueError("conversation page content hash must be canonical 1f lowercase hex")
    return value


def _safe_integer(value, name, *, minimum=0, maximum=MAX_SAFE_INTEGER):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be a safe integer")
    if value < minimum or value > maximum:
        raise ValueError(f"{name} is outside its allowed range")
    return value


def _validate_rows(rows):
    if not isinstance(rows, list):
        raise ValueError("conversation page rows must be an array")
    if len(rows) > MAX_NODE_ROWS:
        raise ValueError("conversation page exceeds the row cap")
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("every conversation page row must be an object")
        record_id = row.get("recordId")
        if not isinstance(record_id, str) or not record_id:
            raise ValueError("every conversation page row must have a recordId")
        if record_id in seen:
            raise ValueError("conversation page contains a duplicate recordId")
        seen.add(record_id)
    return rows


def _encoded_with_length(node):
    candidate = {**node, "byte_length": 0}
    for _ in range(16):
        encoded = json.dumps(candidate, separators=(",", ":"), sort_keys=True).encode("utf-8")
        actual = len(encoded)
        if candidate["byte_length"] == actual:
            if actual > MAX_NODE_BYTES:
                raise ValueError("conversation page exceeds the byte cap")
            return candidate, encoded
        candidate["byte_length"] = actual
    raise ValueError("conversation page byte length did not stabilize")


def build_node(rows, previous_page_content_hash=None):
    rows = _validate_rows(rows)
    previous = _canonical_hash(previous_page_content_hash, nullable=True)
    node, encoded = _encoded_with_length({
        "version": 1,
        "scope": PAGE_SCOPE,
        "rows": rows,
        "row_count": len(rows),
        "previous_page_content_hash": previous,
    })
    return node, encoded


def validate_node_bytes(raw, current_content_hash=None):
    """Validate a node mounted by the workflow's verified blob_ref owner.

    `current_content_hash` is the CAS address used for that mount, not a digest
    this Python leaf mints or recomputes. The leaf validates the bounded bytes and
    uses the address to reject an immediate self-reference in the page chain.
    """
    if not isinstance(raw, bytes) or len(raw) > MAX_NODE_BYTES:
        raise ValueError("conversation page bytes exceed the byte cap")
    try:
        node = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as problem:
        raise ValueError("conversation page is not valid UTF-8 JSON") from problem
    if not isinstance(node, dict) or set(node) != {
        "version", "scope", "rows", "row_count", "previous_page_content_hash", "byte_length"
    }:
        raise ValueError("conversation page has an unknown or missing field")
    if isinstance(node["version"], bool) or not isinstance(node["version"], int) or node["version"] != 1:
        raise ValueError("conversation page version or scope is unsupported")
    if node["scope"] != PAGE_SCOPE:
        raise ValueError("conversation page version or scope is unsupported")
    rows = _validate_rows(node["rows"])
    if _safe_integer(node["row_count"], "row_count", maximum=MAX_NODE_ROWS) != len(rows):
        raise ValueError("conversation page row_count does not match rows")
    if _safe_integer(node["byte_length"], "byte_length", maximum=MAX_NODE_BYTES) != len(raw):
        raise ValueError("conversation page byte_length does not match its bytes")
    previous = _canonical_hash(node["previous_page_content_hash"], nullable=True)
    current = _canonical_hash(current_content_hash, nullable=True)
    if current is not None and previous == current:
        raise ValueError("conversation page chain contains a loop")
    return node


def read_page(raw, current_content_hash, offset, limit):
    current = _canonical_hash(current_content_hash)
    offset = _safe_integer(offset, "offset")
    limit = _safe_integer(limit, "limit", minimum=1, maximum=MAX_PAGE_LIMIT)
    node = validate_node_bytes(raw, current)
    rows = node["rows"]
    if offset > len(rows):
        raise ValueError("conversation page offset exceeds its row count")
    selected = rows[offset:offset + limit]
    next_offset = offset + len(selected)
    if next_offset < len(rows):
        next_cursor = {"content_hash": current, "offset": next_offset}
    elif node["previous_page_content_hash"] is not None:
        next_cursor = {"content_hash": node["previous_page_content_hash"], "offset": 0}
    else:
        next_cursor = None
    result = {"rows": selected, "next_cursor": next_cursor, "has_more": next_cursor is not None}
    if len(json.dumps(result, separators=(",", ":"), sort_keys=True).encode("utf-8")) > MAX_RESPONSE_BYTES:
        raise ValueError("conversation page response exceeds the byte cap")
    return result


def attach_cursor(window, raw_node, node_content_hash):
    if not isinstance(window, dict):
        raise ValueError("chat session window must be an object")
    node_hash = _canonical_hash(node_content_hash)
    node = validate_node_bytes(raw_node, node_hash)
    prior = window.get("conversation_page_cursor")
    if prior is not None:
        if not isinstance(prior, dict) or set(prior) != {"content_hash", "offset"}:
            raise ValueError("prior conversation page cursor is malformed")
        prior_hash = _canonical_hash(prior["content_hash"])
        prior_offset = _safe_integer(prior["offset"], "prior offset")
        if prior_offset != 0:
            raise ValueError("published conversation page cursor must start at offset zero")
    else:
        prior_hash = None
    if node["previous_page_content_hash"] != prior_hash:
        raise ValueError("conversation page does not extend the prior page chain")
    result = dict(window)
    result["conversation_page_scope"] = PAGE_SCOPE
    if node["row_count"] > 0:
        result["conversation_page_cursor"] = {"content_hash": node_hash, "offset": 0}
    return result


def _read_bounded_bytes(path, maximum, name):
    with pathlib.Path(path).open("rb") as source:
        raw = source.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError(f"{name} exceeds the byte cap")
    return raw


def _read_json(path):
    raw = _read_bounded_bytes(path, MAX_WINDOW_BYTES, "chat session window")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as problem:
        raise ValueError("chat session window is not valid UTF-8 JSON") from problem


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        raise SystemExit("usage: conversation-page.py <attach|read> ...")
    operation = argv.pop(0)
    try:
        if operation == "attach" and len(argv) == 4:
            window_path, node_path, node_hash, out_path = argv
            raw_node = _read_bounded_bytes(node_path, MAX_NODE_BYTES, "conversation page")
            result = attach_cursor(_read_json(window_path), raw_node, node_hash)
        elif operation == "read" and len(argv) == 5:
            node_path, current_hash, offset_text, limit_text, out_path = argv
            raw_node = _read_bounded_bytes(node_path, MAX_NODE_BYTES, "conversation page")
            result = read_page(raw_node, current_hash, int(offset_text), int(limit_text))
        else:
            raise ValueError("conversation page operation or arguments are invalid")
        pathlib.Path(out_path).write_text(
            json.dumps(result, separators=(",", ":"), sort_keys=True), encoding="utf-8"
        )
    except (OSError, ValueError) as problem:
        raise SystemExit(str(problem)) from problem


if __name__ == "__main__":
    main()
