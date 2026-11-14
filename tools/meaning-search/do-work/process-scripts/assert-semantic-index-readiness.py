#!/usr/bin/env python3
"""Fail closed unless a semantic index is current for its canonical owner set.

The semantic index owns search representation only.  Before any query is
served, Workflow asks the DATA-described canonical owner for an exact current
snapshot and supplies that reply here alongside the index descriptor,
source descriptor, readiness policy, and durable convergence receipt.

This leaf performs pure validation.  It owns no package inventory, model
selection, I/O routing, or source vocabulary.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from canonical_multihash import require_canonical_multihash


def load(path: str) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def required_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def rows(reply: Any) -> list[dict[str, Any]]:
    if isinstance(reply, list):
        raw_items = reply
    elif isinstance(reply, dict) and isinstance(reply.get("items"), list):
        raw_items = reply["items"]
    else:
        raise ValueError("owner reply must be a full items collection")
    result: list[dict[str, Any]] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        payload = raw.get("payload")
        result.append({**raw, **(payload if isinstance(payload, dict) else {})})
    return result


def one(
    reply: Any,
    *,
    kind: str,
    identity_field: str,
    identity: str,
    label: str,
) -> dict[str, Any]:
    matches = [
        row
        for row in rows(reply)
        if row.get("kind") == kind and row.get(identity_field) == identity
    ]
    if len(matches) != 1:
        raise ValueError(f"{label} requires exactly one current record")
    return matches[0]


def index_not_ready_error(index_id: str) -> ValueError:
    return ValueError(
        f"INDEX_NOT_READY:{index_id}: semantic index source descriptor is absent; build the index first (#119)"
    )


def require_source_descriptor(reply: Any, index_id: str) -> dict[str, Any]:
    matches = [
        row
        for row in rows(reply)
        if row.get("kind") == "capability-index-source-descriptor" and row.get("index_id") == index_id
    ]
    if not matches:
        raise index_not_ready_error(index_id)
    if len(matches) != 1:
        raise ValueError("source descriptor requires exactly one current record")
    return matches[0]


def assert_ready(
    *,
    index_id: str,
    descriptor_reply: Any,
    source_descriptor_reply: Any,
    policy_reply: Any,
    convergence_reply: Any,
    source_scan: Any,
    index_state_reply: Any,
) -> dict[str, Any]:
    source = require_source_descriptor(source_descriptor_reply, index_id)
    descriptor = one(
        descriptor_reply,
        kind="semantic-index-descriptor",
        identity_field="index_id",
        identity=index_id,
        label="semantic index descriptor",
    )
    policy = one(
        policy_reply,
        kind="discovery-readiness-policy",
        identity_field="id",
        identity=index_id,
        label="readiness policy",
    )
    convergence = one(
        convergence_reply,
        kind="semantic-index-convergence",
        identity_field="id",
        identity=index_id,
        label="convergence receipt",
    )

    snapshot = source_scan.get("snapshot") if isinstance(source_scan, dict) else None
    items = source_scan.get("items") if isinstance(source_scan, dict) else None
    if not isinstance(snapshot, dict) or not isinstance(items, list):
        raise ValueError("current source scan requires snapshot and items")
    snapshot_ref = require_canonical_multihash(snapshot.get("digest"), "current source snapshot digest")
    if snapshot.get("count") != len(items):
        raise ValueError("current source snapshot count mismatch")

    index_ref = f"semantic-index-descriptor:{index_id}"
    if source.get("index_ref") != index_ref or policy.get("index_ref") != index_ref:
        raise ValueError("descriptor/readiness index reference mismatch")
    if convergence.get("index_ref") != index_ref or convergence.get("status") != "ready":
        raise ValueError("semantic index is not durably ready")
    if (
        convergence.get("source_snapshot_ref") != snapshot_ref
        or convergence.get("indexed_snapshot_ref") != snapshot_ref
    ):
        raise ValueError("semantic index snapshot is stale")
    if convergence.get("descriptor_count") != len(items):
        raise ValueError("semantic index descriptor count is stale")

    # A receipt records a completed convergence; it is not authority for the
    # mutable representation.  Every query therefore checks the exact current
    # Meaning Search state against the exact current owner snapshot.
    property_id = f"prop:semantic-ann-index:{index_id}"
    state_rows = [
        row for row in rows(index_state_reply)
        if row.get("table") == "attribute_fact" and row.get("property_id") == property_id
    ]
    if len(state_rows) > 1:
        raise ValueError("multiple current semantic index state rows")
    state_value = state_rows[0].get("value_json") if state_rows else "{\"subjects\":{}}"
    if not isinstance(state_value, str):
        raise ValueError("semantic index state value_json must be text")
    state = json.loads(state_value)
    subjects = state.get("subjects") if isinstance(state, dict) else None
    if not isinstance(subjects, dict):
        raise ValueError("semantic index state subjects must be an object")
    expected = {}
    for raw in items:
        if not isinstance(raw, dict):
            raise ValueError("current source item must be an object")
        address = required_text(raw.get("address"), "current source address")
        content_hash = require_canonical_multihash(raw.get("content_hash"), "current source content hash")
        expected[address] = content_hash
    live = {address: value for address, value in subjects.items()
            if isinstance(value, dict) and not value.get("removed")}
    if set(live) != set(expected):
        raise ValueError("semantic index membership is stale")
    for address, content_hash in expected.items():
        entry = live[address]
        if (entry.get("canonical_address") != address
                or entry.get("revision") != content_hash
                or entry.get("payload_hash") != content_hash
                or entry.get("source_snapshot_ref") != snapshot_ref):
            raise ValueError("semantic index identity is stale")

    descriptor_revision = require_canonical_multihash(
        descriptor.get("descriptor_revision"), "index descriptor revision"
    )
    model_provenance_ref = required_text(
        descriptor.get("model_provenance_ref"), "index model provenance"
    )
    if convergence.get("index_descriptor_revision") != descriptor_revision:
        raise ValueError("convergence descriptor revision is stale")
    if convergence.get("model_provenance_ref") != model_provenance_ref:
        raise ValueError("convergence model provenance is stale")

    require_canonical_multihash(convergence.get("completion_receipt_ref"), "completion receipt")
    evidence = convergence.get("sampled_hydrations")
    if not isinstance(evidence, list):
        raise ValueError("sampled hydration evidence is invalid")
    hydration_sample_count = source.get("hydration_sample_count")
    if (
        not isinstance(hydration_sample_count, int)
        or isinstance(hydration_sample_count, bool)
        or hydration_sample_count < 1
    ):
        raise ValueError("source hydration sample count is invalid")
    expected_samples = min(hydration_sample_count, len(items))
    if len(evidence) != expected_samples:
        raise ValueError("sampled owner hydration is incomplete")
    seen = set()
    for item in evidence:
        if not isinstance(item, dict):
            raise ValueError("sampled hydration evidence item is invalid")
        address = required_text(item.get("canonical_address"), "hydrated canonical address")
        revision = require_canonical_multihash(item.get("canonical_revision"), "hydrated canonical revision")
        payload_hash = require_canonical_multihash(item.get("payload_hash"), "hydrated payload hash")
        if address in seen or expected.get(address) != revision or revision != payload_hash:
            raise ValueError("sampled hydration identity is stale")
        seen.add(address)

    required = policy.get("requires")
    if not isinstance(required, list) or not required:
        raise ValueError("readiness policy has no requirements")
    return {
        "status": "ready",
        "index_id": index_id,
        "source_snapshot_ref": snapshot_ref,
        "descriptor_count": len(items),
        "completion_receipt_ref": convergence["completion_receipt_ref"],
    }


def prepare_probe(index_id: str, records_reply: Any) -> dict[str, Any]:
    source = require_source_descriptor(records_reply, index_id)
    owner_query = source.get("owner_query")
    if not isinstance(owner_query, dict):
        raise ValueError("source descriptor owner_query must be an object")
    target = required_text(owner_query.get("target"), "source owner query target")
    request = owner_query.get("request")
    if not isinstance(request, dict):
        raise ValueError("source owner query request must be an object")
    include = request.get("include")
    if (
        request.get("operation") != "find-current-items"
        or request.get("snapshot") is not True
        or not isinstance(include, list)
        or "address" not in include
        or "content_hash" not in include
    ):
        raise ValueError("source owner query must request an exact identity snapshot")
    return {"target": target, "request": request}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("prepare", "assert"), required=True)
    parser.add_argument("--index-id", required=True)
    parser.add_argument("--records-json", required=True)
    parser.add_argument("--source-scan-json")
    parser.add_argument("--index-state-json")
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()
    index_id = required_text(args.index_id, "index id")
    records = load(args.records_json)
    if args.mode == "prepare":
        result = prepare_probe(index_id, records)
    else:
        if not args.source_scan_json or not args.index_state_json:
            raise ValueError("assert mode requires --source-scan-json and --index-state-json")
        result = assert_ready(
            index_id=index_id,
            descriptor_reply=records,
            source_descriptor_reply=records,
            policy_reply=records,
            convergence_reply=records,
            source_scan=load(args.source_scan_json),
            index_state_reply=load(args.index_state_json),
        )
    Path(args.output_json).write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
