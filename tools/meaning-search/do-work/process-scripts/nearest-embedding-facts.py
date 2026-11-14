#!/usr/bin/env python3
"""Nearest-neighbor ranking over EEAF embedding fact rows (cosine similarity).

Contract (named by the semantic-index-descriptor's nearest_executor.argv):
  --embedding-json  embedding.json  ({"vector":[...]} from the embed executor)
  --input-json      input.json      (the action input; optional limit)
  --descriptor-json descriptor.json (the semantic-index-descriptor; min_score)
  --facts-json      facts.json      (find-current-items attribute_fact rows)
  --output-json     nearest.json    ({"items":[canonical ranked representations], ...})

Fail-closed: results below min_score are dropped (never padded); malformed fact
rows are skipped and counted, never guessed at.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from canonical_multihash import require_canonical_multihash


def load(path: str):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        return -1.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0.0 or nb == 0.0:
        return -1.0
    return dot / (na * nb)


def canonical_item(row: dict, score: float, descriptor: dict) -> dict:
    """Return representation only; callers hydrate the canonical owner later.

    The index never copies a workflow definition or a surface payload.  It may
    expose the bounded identity/provenance needed to prove that the eventual
    owner hydration is still current.
    """
    subject = row.get("canonical_address", row.get("subject_id"))
    if not isinstance(subject, str) or not subject:
        raise ValueError("missing canonical address")
    revision = row.get("canonical_revision", row.get("revision"))
    payload_hash = row.get("canonical_payload_hash", row.get("payload_hash"))
    source_snapshot_ref = row.get("source_snapshot_ref")
    try:
        revision = require_canonical_multihash(revision, "candidate revision")
        payload_hash = require_canonical_multihash(payload_hash, "candidate payload hash")
        source_snapshot_ref = require_canonical_multihash(source_snapshot_ref, "candidate source snapshot")
        descriptor_revision = require_canonical_multihash(
            descriptor.get("descriptor_revision"),
            "semantic index descriptor revision",
        )
    except ValueError as exc:
        raise ValueError("candidate lacks canonical revision, payload hash, or source snapshot reference") from exc
    model_provenance_ref = descriptor.get("model_provenance_ref")
    if not isinstance(model_provenance_ref, str) or not model_provenance_ref:
        raise ValueError("semantic index descriptor lacks model provenance")
    item = {
        "address": subject,
        "score": round(score, 6),
        "index_id": descriptor.get("index_id"),
        "model_id": descriptor.get("model_id"),
        "model_version": descriptor.get("model_version"),
        "descriptor_revision": descriptor_revision,
        "model_provenance_ref": model_provenance_ref,
        "revision": revision, "source_snapshot_ref": source_snapshot_ref,
        "payload_hash": payload_hash,
    }
    for key in (
        "owner_target",
        "schema_ref",
        "schema_digest",
        "authority_provenance_ref",
        "surface_ref",
        "title",
        "description",
    ):
        value = row.get(key)
        if value is not None:
            item[key] = value
    return item


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--embedding-json", required=True)
    parser.add_argument("--input-json", required=True)
    parser.add_argument("--descriptor-json", required=True)
    parser.add_argument("--facts-json", required=True)
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()

    embedding = load(args.embedding_json)
    query = embedding.get("vector")
    if not isinstance(query, list) or not query:
        print("[nearest-embedding-facts] embedding output has no numeric vector", file=sys.stderr)
        return 1
    query = [float(v) for v in query]
    action_input = load(args.input_json)
    descriptor = load(args.descriptor_json)
    if not isinstance(descriptor.get("result_limit"), int) or descriptor["result_limit"] < 1:
        print("[nearest-embedding-facts] descriptor result_limit must be a positive integer", file=sys.stderr)
        return 1
    if not isinstance(descriptor.get("min_score"), (int, float)):
        print("[nearest-embedding-facts] descriptor min_score must be numeric", file=sys.stderr)
        return 1
    descriptor_limit = descriptor["result_limit"]
    requested_limit = action_input.get("limit", descriptor_limit)
    try:
        limit = min(int(requested_limit), descriptor_limit)
    except (TypeError, ValueError):
        print("[nearest-embedding-facts] limit must be an integer", file=sys.stderr)
        return 1
    if limit < 1:
        print("[nearest-embedding-facts] limit must be positive", file=sys.stderr)
        return 1
    min_score = float(descriptor["min_score"])

    facts = load(args.facts_json)
    rows = facts.get("items", facts) if isinstance(facts, dict) else facts
    scored, skipped = [], 0
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            skipped += 1
            continue
        subject = row.get("subject_id")
        try:
            representation = json.loads(row.get("value_json") or "null")
            assert isinstance(representation, dict)
            vector = representation.get("vector")
            assert isinstance(vector, list) and vector
            score = cosine(query, [float(v) for v in vector])
            row = {**row, **representation}
        except Exception:
            skipped += 1
            continue
        if isinstance(subject, str) and subject and score >= min_score:
            try:
                scored.append(canonical_item(row, score, descriptor))
            except ValueError:
                skipped += 1
    # A stable total order is required before truncation: otherwise two equal
    # candidates at the descriptor limit depend on source/fact iteration order
    # and a downstream owner cannot recover the discarded canonical result.
    scored.sort(key=lambda item: (-item["score"], item["address"], item["revision"], item["payload_hash"]))
    output = {"items": scored[:limit], "considered": len(rows) if isinstance(rows, list) else 0,
              "skipped": skipped, "min_score": min_score}
    with open(args.output_json, "w", encoding="utf-8") as handle:
        json.dump(output, handle, separators=(",", ":"))
    print(f"[nearest-embedding-facts] ranked {len(scored)} of {output['considered']} rows, returned {len(output['items'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
