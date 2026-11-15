#!/usr/bin/env python3
"""Plan or verify generic semantic-index convergence from owner snapshots.

This is a pure translation leaf. It owns no I/O, workflow dispatch, model,
package inventory, or capability vocabulary. Workflow supplies:

- exact current-owner snapshots from ``slot::find-current-items``;
- the current semantic index state owned by Meaning Search;
- descriptor DATA containing resource bounds and provenance.

``plan`` emits generic upsert/retract action inputs. ``verify`` admits
readiness only when two independently-read owner snapshots are identical and
the index representation exactly matches that set. Snapshot references are
cryptographic identities, never clocks.
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


def write(path: str, value: Any) -> None:
    Path(path).write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def required_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def snapshot_rows(scan: Any) -> tuple[str, list[dict[str, str]]]:
    if not isinstance(scan, dict):
        raise ValueError("owner scan must be an object")
    snapshot = scan.get("snapshot")
    items = scan.get("items")
    if not isinstance(snapshot, dict) or not isinstance(items, list):
        raise ValueError("owner scan requires snapshot and items")
    digest = require_canonical_multihash(snapshot.get("digest"), "snapshot.digest")
    if snapshot.get("count") != len(items):
        raise ValueError("snapshot.count does not match owner items")

    by_address: dict[str, dict[str, str]] = {}
    for raw in items:
        if not isinstance(raw, dict):
            raise ValueError("owner item must be an object")
        address = required_text(raw.get("address"), "owner item address")
        payload_hash = require_canonical_multihash(raw.get("content_hash"), "owner item content_hash")
        payload_text = required_text(raw.get("payload_json_text"), "owner item payload_json_text")
        row = {
            "address": address,
            "revision": payload_hash,
            "payload_hash": payload_hash,
            "payload_text": payload_text,
        }
        previous = by_address.get(address)
        if previous is not None and previous != row:
            raise ValueError("duplicate owner address has conflicting current rows")
        by_address[address] = row
    return digest, [by_address[key] for key in sorted(by_address)]


def index_subjects(reply: Any, index_id: str) -> dict[str, dict[str, Any]]:
    rows = reply.get("items", []) if isinstance(reply, dict) else []
    if not isinstance(rows, list):
        raise ValueError("index-state reply items must be an array")
    property_id = f"prop:semantic-ann-index:{index_id}"
    states: list[dict[str, Any]] = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        row = {**raw, **(raw.get("payload") if isinstance(raw.get("payload"), dict) else {})}
        if row.get("table") != "attribute_fact" or row.get("property_id") != property_id:
            continue
        value_json = row.get("value_json")
        if not isinstance(value_json, str):
            raise ValueError("semantic index state value_json must be a string")
        state = json.loads(value_json)
        if not isinstance(state, dict):
            raise ValueError("semantic index state must be an object")
        states.append(state)
    if len(states) > 1:
        raise ValueError("multiple current semantic index state rows")
    subjects = states[0].get("subjects", {}) if states else {}
    if not isinstance(subjects, dict):
        raise ValueError("semantic index subjects must be an object")
    return subjects


def positive_int(record: dict[str, Any], key: str) -> int:
    value = record.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"descriptor {key} must be a positive integer")
    return value


def exactly_one_descriptor(reply_or_record: Any, kind: str) -> dict[str, Any]:
    """Translate the exact bounded query-row array into one owner descriptor."""
    if isinstance(reply_or_record, list):
        items = reply_or_record
    elif isinstance(reply_or_record, dict):
        items = reply_or_record.get("items")
        if items is None:
            return reply_or_record
        if not isinstance(items, list):
            raise ValueError(f"{kind} reply items must be an array")
    else:
        raise ValueError(f"{kind} reply must be an object or row array")
    matches = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        item = {**raw, **(raw.get("payload") if isinstance(raw.get("payload"), dict) else {})}
        if item.get("kind") == kind:
            matches.append(item)
    if len(matches) != 1:
        raise ValueError(f"{kind} requires exactly one current descriptor")
    return matches[0]


def projected_descriptor(
    source_descriptor: dict[str, Any],
    index_descriptor: dict[str, Any],
) -> dict[str, Any]:
    """Translate the two owner records into the planner's read-only view.

    Source selection/bounds remain owned by the source descriptor. Model and
    index revision provenance remain owned by the semantic index descriptor.
    The translation boundary rejects crossed references instead of copying
    those truths into both records.
    """
    source_descriptor = exactly_one_descriptor(
        source_descriptor, "capability-index-source-descriptor"
    )
    index_descriptor = exactly_one_descriptor(
        index_descriptor, "semantic-index-descriptor"
    )
    index_id = required_text(index_descriptor.get("index_id"), "index descriptor index_id")
    expected_ref = f"semantic-index-descriptor:{index_id}"
    if source_descriptor.get("index_id") != index_id:
        raise ValueError("source descriptor index_id does not match index descriptor")
    if source_descriptor.get("index_ref") != expected_ref:
        raise ValueError("source descriptor index_ref does not match index descriptor")
    return {
        **source_descriptor,
        "index_id": index_id,
        "descriptor_revision": required_text(
            index_descriptor.get("descriptor_revision"),
            "index descriptor descriptor_revision",
        ),
        "model_provenance_ref": required_text(
            index_descriptor.get("model_provenance_ref"),
            "index descriptor model_provenance_ref",
        ),
    }


def prepare(source_reply: Any, index_reply: Any) -> dict[str, Any]:
    """Validate full owner replies before a Workflow may perform a dynamic scan."""
    source = exactly_one_descriptor(source_reply, "capability-index-source-descriptor")
    index = exactly_one_descriptor(index_reply, "semantic-index-descriptor")
    descriptor = projected_descriptor(source, index)
    owner_query = source.get("owner_query")
    if not isinstance(owner_query, dict):
        raise ValueError("source descriptor owner_query must be an object")
    target = required_text(owner_query.get("target"), "source descriptor owner_query.target")
    request = owner_query.get("request")
    if not isinstance(request, dict):
        raise ValueError("source descriptor owner_query.request must be an object")
    return {"owner_query_target": target, "owner_query": request,
            "source_descriptor": source, "index_descriptor": index,
            "projected_descriptor": descriptor}


def search_metadata(
    row: dict[str, str],
    descriptor: dict[str, Any],
) -> dict[str, str]:
    payload = json.loads(row["payload_text"])
    if not isinstance(payload, dict):
        raise ValueError("owner payload must be an object")
    kind = required_text(payload.get("kind"), "owner payload kind")
    owner_targets = descriptor.get("owner_targets")
    if not isinstance(owner_targets, dict):
        raise ValueError("descriptor owner_targets must be an object")
    owner_target = payload.get("owner_target", owner_targets.get(kind))
    metadata = {
        "owner_target": required_text(owner_target, "owner target"),
        "schema_ref": required_text(
            payload.get("schema_ref", row["address"]), "schema_ref"
        ),
        "schema_digest": required_text(
            payload.get("schema_digest", row["payload_hash"]), "schema_digest"
        ),
        "authority_provenance_ref": required_text(
            payload.get(
                "authority_provenance_ref",
                descriptor.get("authority_provenance_ref"),
            ),
            "authority_provenance_ref",
        ),
    }
    title = payload.get("title", payload.get("label", payload.get("name")))
    description = payload.get("description")
    if isinstance(title, str) and title:
        metadata["title"] = title
    if isinstance(description, str):
        metadata["description"] = description
    if kind == "placeable-surface":
        metadata["surface_ref"] = row["address"]
    return metadata


def planned_upsert(
    row: dict[str, str],
    descriptor: dict[str, Any],
    source_snapshot_ref: str,
    at: str,
) -> dict[str, Any]:
    mutation = {
        "index_id": required_text(descriptor.get("index_id"), "descriptor index_id"),
        "content_address": row["address"],
        "canonical_address": row["address"],
        "canonical_revision": row["revision"],
        "canonical_payload_hash": row["payload_hash"],
        "source_snapshot_ref": source_snapshot_ref,
        "content_text": row["payload_text"],
        "search_metadata": search_metadata(row, descriptor),
        "at": required_text(at, "at"),
    }
    vector_field = descriptor.get("content_vector_field")
    if vector_field is not None:
        vector_field = required_text(vector_field, "descriptor content_vector_field")
        payload = json.loads(row["payload_text"])
        if not isinstance(payload, dict):
            raise ValueError("owner payload must be an object")
        mutation["content_vector_base64"] = required_text(
            payload.get(vector_field),
            f"owner payload {vector_field}",
        )
    return mutation


def plan(scan: Any, state_reply: Any, descriptor: dict[str, Any], at: str) -> dict[str, Any]:
    index_id = required_text(descriptor.get("index_id"), "descriptor index_id")
    max_source_count = positive_int(descriptor, "max_source_count")
    digest, rows = snapshot_rows(scan)
    if len(rows) > max_source_count:
        raise ValueError("owner snapshot exceeds descriptor max_source_count")
    subjects = index_subjects(state_reply, index_id)
    current_addresses = {row["address"] for row in rows}

    upserts = []
    for row in rows:
        indexed = subjects.get(row["address"])
        already_current = (
            isinstance(indexed, dict)
            and not indexed.get("removed")
            and indexed.get("canonical_address") == row["address"]
            and indexed.get("revision") == row["revision"]
            and indexed.get("payload_hash") == row["payload_hash"]
            and indexed.get("source_snapshot_ref") == digest
        )
        if not already_current:
            upserts.append(planned_upsert(row, descriptor, digest, at))
    retracts = []
    for address in sorted(subjects):
        metadata = subjects[address]
        if address in current_addresses or not isinstance(metadata, dict) or metadata.get("removed"):
            continue
        retracts.append(
            {
                "index_id": index_id,
                "content_address": address,
                "canonical_address": required_text(
                    metadata.get("canonical_address", address), "indexed canonical_address"
                ),
                "canonical_revision": require_canonical_multihash(metadata.get("revision"), "indexed revision"),
                "canonical_payload_hash": require_canonical_multihash(
                    metadata.get("payload_hash"), "indexed payload_hash"
                ),
                "source_snapshot_ref": digest,
            }
        )
    return {
        "status": "planned",
        "source_snapshot_ref": digest,
        "descriptor_count": len(rows),
        "upserts": upserts,
        "retracts": retracts,
    }


def verify(
    first_scan: Any,
    second_scan: Any,
    state_reply: Any,
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    index_id = required_text(descriptor.get("index_id"), "descriptor index_id")
    first_digest, first_rows = snapshot_rows(first_scan)
    second_digest, second_rows = snapshot_rows(second_scan)
    if first_digest != second_digest or first_rows != second_rows:
        return {
            "status": "unstable",
            "source_snapshot_ref": second_digest,
            "reason_ref": "owner-snapshot-changed",
            "samples": [],
        }

    subjects = index_subjects(state_reply, index_id)
    live_subjects = {
        address: value
        for address, value in subjects.items()
        if isinstance(value, dict) and not value.get("removed")
    }
    expected = {row["address"]: row for row in second_rows}
    if set(live_subjects) != set(expected):
        return {
            "status": "unstable",
            "source_snapshot_ref": second_digest,
            "reason_ref": "index-membership-mismatch",
            "samples": [],
        }
    for address, row in expected.items():
        indexed = live_subjects[address]
        if (
            indexed.get("canonical_address") != address
            or indexed.get("revision") != row["revision"]
            or indexed.get("payload_hash") != row["payload_hash"]
            or indexed.get("source_snapshot_ref") != second_digest
        ):
            return {
                "status": "unstable",
                "source_snapshot_ref": second_digest,
                "reason_ref": "index-identity-mismatch",
                "samples": [],
            }

    sample_count = min(positive_int(descriptor, "hydration_sample_count"), len(second_rows))
    samples = []
    for row in second_rows[:sample_count]:
        metadata = search_metadata(row, descriptor)
        samples.append({
            "owner_query_target": required_text(
                descriptor.get("owner_query", {}).get("target")
                if isinstance(descriptor.get("owner_query"), dict) else None,
                "descriptor owner_query.target",
            ),
            "owner_query": {
                "operation": "find-current-items",
                "in": "published-record",
                "addresses": [row["address"]],
                "include": ["address", "content_hash", "payload"],
            },
            **metadata,
            "canonical_address": row["address"],
            "canonical_revision": row["revision"],
            "payload_hash": row["payload_hash"],
            "descriptor_revision": require_canonical_multihash(
                descriptor.get("descriptor_revision"),
                "descriptor descriptor_revision",
            ),
            "model_provenance_ref": required_text(
                descriptor.get("model_provenance_ref"),
                "descriptor model_provenance_ref",
            ),
        })
    return {
        "status": "ready",
        "source_snapshot_ref": second_digest,
        "indexed_snapshot_ref": second_digest,
        "descriptor_count": len(second_rows),
        "index_descriptor_revision": require_canonical_multihash(
            descriptor.get("descriptor_revision"), "descriptor descriptor_revision"
        ),
        "model_provenance_ref": required_text(
            descriptor.get("model_provenance_ref"), "descriptor model_provenance_ref"
        ),
        "samples": samples,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("prepare", "plan", "verify"), required=True)
    parser.add_argument("--scan-a-json")
    parser.add_argument("--scan-b-json")
    parser.add_argument("--index-state-json")
    parser.add_argument("--descriptor-json", required=True)
    parser.add_argument("--index-descriptor-json", required=True)
    parser.add_argument("--at", default="")
    parser.add_argument(
        "--require-ready",
        action="store_true",
        help="fail the process unless verification reached the ready fixed point",
    )
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()
    source_descriptor = load(args.descriptor_json)
    index_descriptor = load(args.index_descriptor_json)
    if not isinstance(source_descriptor, (dict, list)):
        raise ValueError("source descriptor must be an object or exact row array")
    if not isinstance(index_descriptor, (dict, list)):
        raise ValueError("index descriptor must be an object or exact row array")
    if args.mode == "prepare":
        result = prepare(source_descriptor, index_descriptor)
    else:
        if not args.scan_a_json or not args.index_state_json:
            raise ValueError("plan/verify requires scan-a-json and index-state-json")
        descriptor = projected_descriptor(source_descriptor, index_descriptor)
        if args.mode == "plan":
            result = plan(
                load(args.scan_a_json),
                load(args.index_state_json),
                descriptor,
                args.at,
            )
        else:
            if not args.scan_b_json:
                raise ValueError("verify requires --scan-b-json")
            result = verify(
                load(args.scan_a_json),
                load(args.scan_b_json),
                load(args.index_state_json),
                descriptor,
            )
            if args.require_ready and result.get("status") != "ready":
                raise ValueError(
                    f"semantic-index convergence is not ready: {result.get('reason_ref', 'unknown')}"
                )
    write(args.output_json, result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
