#!/usr/bin/env python3
"""Make EEAF embedding fact rows from embedding-executor command output.

Content-agnostic: the subject is whatever address the request names. The
executor's output JSON must contain a numeric "vector" list; model identity
comes from the request's descriptor echo, never from this script.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path
from typing import Any

PUBLISHED_PATH = ["current-item", "published-record"]


def read_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("JSON input must be an object")
    return value


def write_json(path: str, value: Any) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))


def object_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def required_text(source: dict[str, Any], key: str) -> str:
    value = source.get(key)
    if not isinstance(value, str) or value == "":
        raise ValueError(f"missing required non-empty string field: {key}")
    return value


def vector_from_command_output(command_output: dict[str, Any]) -> list[float]:
    raw = command_output.get("vector", command_output.get("embedding"))
    if not isinstance(raw, list) or not raw:
        raise ValueError("embedding command output must contain non-empty numeric list 'vector' (or 'embedding')")
    vector: list[float] = []
    for item in raw:
        if not isinstance(item, (int, float)) or isinstance(item, bool):
            raise ValueError("embedding vector entries must all be numbers")
        vector.append(float(item))
    return vector


def decoded_precomputed_vector(encoded: Any) -> list[float]:
    if not isinstance(encoded, str) or not encoded:
        raise ValueError("content_vector_base64 must be a non-empty string")
    try:
        value = json.loads(base64.b64decode(encoded, validate=True).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("content_vector_base64 must contain base64-encoded JSON") from error
    if not isinstance(value, dict):
        raise ValueError("content_vector_base64 JSON must be an object")
    return vector_from_command_output(value)


def fact_rows(request: dict[str, Any], command_output: dict[str, Any], index_descriptor: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    content_address = required_text(request, "content_address")
    index_id = required_text(request, "index_id")
    at = required_text(request, "at")
    canonical_address = required_text(request, "canonical_address")
    canonical_revision = required_text(request, "canonical_revision")
    canonical_payload_hash = required_text(request, "canonical_payload_hash")
    source_snapshot_ref = required_text(request, "source_snapshot_ref")
    search_metadata = object_or_empty(request.get("search_metadata"))
    allowed_metadata = {
        key: search_metadata[key]
        for key in (
            "owner_target",
            "schema_ref",
            "schema_digest",
            "authority_provenance_ref",
            "surface_ref",
            "title",
            "description",
        )
        if key in search_metadata
    }
    if allowed_metadata:
        for key in ("owner_target", "schema_ref", "schema_digest", "authority_provenance_ref"):
            required_text(allowed_metadata, key)
    vector = vector_from_command_output(command_output)
    descriptor = (
        object_or_empty(command_output.get("provenance"))
        or object_or_empty(request.get("provenance"))
        or object_or_empty(index_descriptor)
    )
    model_id = str(descriptor.get("model_id") or command_output.get("model_id") or "")
    model_version = str(descriptor.get("model_version") or command_output.get("model_version") or "")
    if model_id == "":
        raise ValueError("model_id provenance is required (command output or request provenance)")
    type_id = "type:semantic-indexed"
    embed_prop = f"prop:semantic-embedding:{index_id}"
    prov_prop = f"prop:semantic-provenance:{index_id}"
    provenance_json = json.dumps(
        {"model_id": model_id, "model_version": model_version, "at": at},
        ensure_ascii=False, separators=(",", ":"),
    )

    return [
        {"address": f"entity|{content_address}", "path": PUBLISHED_PATH,
         "payload": {"table": "entity", "id": content_address}},
        {"address": f"entity_types|{content_address}|{type_id}", "path": PUBLISHED_PATH,
         "payload": {"table": "entity_types", "entity_id": content_address, "type_id": type_id}},
        {"address": f"type_properties|{type_id}|{embed_prop}", "path": PUBLISHED_PATH,
         "payload": {"table": "type_properties", "type_id": type_id, "property_id": embed_prop}},
        {"address": f"attribute_fact|{content_address}|{embed_prop}|{type_id}", "path": PUBLISHED_PATH,
         "payload": {"table": "attribute_fact", "subject_id": content_address,
                     "property_id": embed_prop, "type_id": type_id,
                     "value_json": json.dumps({"vector": vector, **allowed_metadata,
                                                 "canonical_address": canonical_address,
                                                 "canonical_revision": canonical_revision,
                                                 "canonical_payload_hash": canonical_payload_hash,
                                                 "source_snapshot_ref": source_snapshot_ref},
                                               ensure_ascii=False, separators=(",", ":"))}},
        {"address": f"attribute_fact|{content_address}|{prov_prop}|{type_id}", "path": PUBLISHED_PATH,
         "payload": {"table": "attribute_fact", "subject_id": content_address,
                     "property_id": prov_prop, "type_id": type_id,
                     "value_json": json.dumps({**json.loads(provenance_json), **allowed_metadata,
                                                 "canonical_address": canonical_address,
                                                 "canonical_revision": canonical_revision,
                                                 "canonical_payload_hash": canonical_payload_hash,
                                                 "source_snapshot_ref": source_snapshot_ref},
                                               ensure_ascii=False, separators=(",", ":"))}},
    ]


def batch_fact_rows(
    plan: dict[str, Any],
    command_output: dict[str, Any],
    index_descriptor: dict[str, Any],
) -> tuple[dict[str, list[float]], list[dict[str, Any]]]:
    raw_upserts = plan.get("upserts")
    if not isinstance(raw_upserts, list) or not all(
        isinstance(item, dict) for item in raw_upserts
    ):
        raise ValueError("convergence plan upserts must be an array of objects")
    raw_vectors = command_output.get("vectors", {})
    if not isinstance(raw_vectors, dict):
        raise ValueError("batch command output vectors must be an object")

    needs_embedding = {
        required_text(item, "content_address")
        for item in raw_upserts
        if "content_vector_base64" not in item
    }
    if set(raw_vectors) != needs_embedding:
        raise ValueError(
            "batch command output vector ids must exactly match non-precomputed upserts"
        )

    provenance = object_or_empty(command_output.get("provenance"))
    vectors: dict[str, list[float]] = {}
    rows_by_address: dict[str, dict[str, Any]] = {}
    address_order: list[str] = []
    for item in raw_upserts:
        content_address = required_text(item, "content_address")
        if content_address in vectors:
            raise ValueError(f"duplicate convergence upsert address: {content_address}")
        vector = (
            decoded_precomputed_vector(item["content_vector_base64"])
            if "content_vector_base64" in item
            else vector_from_command_output({"vector": raw_vectors[content_address]})
        )
        vectors[content_address] = vector
        output: dict[str, Any] = {"vector": vector}
        if provenance:
            output["provenance"] = provenance
        for row in fact_rows(item, output, index_descriptor):
            address = required_text(row, "address")
            if address not in rows_by_address:
                address_order.append(address)
            rows_by_address[address] = row
    return vectors, [rows_by_address[address] for address in address_order]


def main() -> int:
    parser = argparse.ArgumentParser()
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--request-json")
    input_group.add_argument("--plan-json")
    parser.add_argument("--command-output-json", required=True)
    parser.add_argument("--descriptor-json")
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--output-vectors-json")
    args = parser.parse_args()

    command_output = read_json(args.command_output_json)
    index_descriptor = read_json(args.descriptor_json) if args.descriptor_json else None
    if args.plan_json:
        if index_descriptor is None:
            raise ValueError("batch fact generation requires --descriptor-json")
        if not args.output_vectors_json:
            raise ValueError("batch fact generation requires --output-vectors-json")
        plan = read_json(args.plan_json)
        vectors, rows = batch_fact_rows(plan, command_output, index_descriptor)
        write_json(args.output_vectors_json, vectors)
        subject = f"{len(vectors)} convergence upserts"
    else:
        request = read_json(args.request_json)
        rows = fact_rows(request, command_output, index_descriptor)
        subject = request.get("content_address")
    write_json(args.output_json, rows)
    print(f"[meaning-search] wrote {len(rows)} fact rows for {subject}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[meaning-search] error: {exc}", file=sys.stderr)
        raise SystemExit(1)
