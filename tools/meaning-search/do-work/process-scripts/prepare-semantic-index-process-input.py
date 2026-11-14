#!/usr/bin/env python3
"""Project exact current descriptor and optional singleton ANN state for a job.

Workflow replies are collections.  Process jobs must never choose a row by
position: this pure preparation leaf accepts the full replies, enforces their
cardinality, and emits only the validated values a process may consume.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load(path: str) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def rows(reply: Any) -> list[dict[str, Any]]:
    if isinstance(reply, list):
        raw_items = reply
    elif isinstance(reply, dict) and isinstance(reply.get("items"), list):
        raw_items = reply["items"]
    else:
        raise ValueError("reply must be a full items collection")
    result: list[dict[str, Any]] = []
    for raw in raw_items:
        if isinstance(raw, dict):
            payload = raw.get("payload")
            result.append({**raw, **(payload if isinstance(payload, dict) else {})})
    return result


def exact_descriptor(reply: Any, index_id: str) -> dict[str, Any]:
    matches = [row for row in rows(reply) if row.get("kind") == "semantic-index-descriptor" and row.get("index_id") == index_id]
    if len(matches) != 1:
        raise ValueError("semantic index descriptor requires exactly one current row")
    return matches[0]


def optional_ann_state(reply: Any, index_id: str) -> str:
    property_id = f"prop:semantic-ann-index:{index_id}"
    matches = [row for row in rows(reply) if row.get("table") == "attribute_fact" and row.get("property_id") == property_id]
    if len(matches) > 1:
        raise ValueError("semantic ANN state requires zero or one current row")
    if not matches:
        return "{}"
    value = matches[0].get("value_json")
    if not isinstance(value, str):
        raise ValueError("semantic ANN state value_json must be text")
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError("semantic ANN state must be an object")
    return value


def embedding_request(plan: Any) -> dict[str, Any]:
    if not isinstance(plan, dict):
        raise ValueError("semantic index plan must be an object")
    upserts = plan.get("upserts")
    if not isinstance(upserts, list):
        raise ValueError("semantic index plan upserts must be an array")
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    for mutation in upserts:
        if not isinstance(mutation, dict):
            raise ValueError("semantic index plan upserts must contain objects")
        if "content_vector_base64" in mutation:
            continue
        item_id = mutation.get("content_address")
        text = mutation.get("content_text")
        if not isinstance(item_id, str) or not item_id:
            raise ValueError("semantic index upsert requires content_address")
        if item_id in seen:
            raise ValueError(f"duplicate semantic index upsert: {item_id}")
        if not isinstance(text, str) or not text:
            raise ValueError(f"semantic index upsert {item_id!r} requires content_text")
        seen.add(item_id)
        items.append({"id": item_id, "text": text})
    return {"items": items}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index-id", required=True)
    parser.add_argument("--descriptor-reply-json", required=True)
    parser.add_argument("--ann-state-reply-json", required=True)
    parser.add_argument("--plan-json")
    parser.add_argument("--embedding-request-json")
    parser.add_argument("--output-state-json", required=True)
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()
    if not args.index_id:
        raise ValueError("index_id is required")
    if bool(args.plan_json) != bool(args.embedding_request_json):
        raise ValueError(
            "plan-json and embedding-request-json must be supplied together"
        )
    descriptor = exact_descriptor(load(args.descriptor_reply_json), args.index_id)
    state_value_json = optional_ann_state(load(args.ann_state_reply_json), args.index_id)
    output = {"descriptor": descriptor}
    Path(args.output_state_json).write_text(state_value_json, encoding="utf-8")
    Path(args.output_json).write_text(
        json.dumps(output, separators=(",", ":")),
        encoding="utf-8",
    )
    if args.plan_json:
        request = embedding_request(load(args.plan_json))
        Path(args.embedding_request_json).write_text(
            json.dumps(request, separators=(",", ":")),
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
