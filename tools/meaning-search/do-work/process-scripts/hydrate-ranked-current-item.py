#!/usr/bin/env python3
"""Fail-closed canonical hydration for one ranked search representation.

The index owns only a representation.  This leaf validates an Envelope reply
from the descriptor-selected canonical owner and emits exactly one current
record only when address, opaque revision, and content hash all agree.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from canonical_multihash import require_canonical_multihash


def load(path: str):
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def rows(value):
    if isinstance(value, dict):
        value = value.get("items", value.get("output", {}).get("items", []))
    return value if isinstance(value, list) else []


def flat(value):
    return {**value, **value.get("payload", {})} if isinstance(value, dict) and isinstance(value.get("payload"), dict) else value


def hydrate(request, reply):
    if not isinstance(request.get("canonical_address"), str) or not request["canonical_address"]:
        raise ValueError("canonical address is required")
    require_canonical_multihash(request.get("canonical_revision"), "canonical revision")
    require_canonical_multihash(request.get("payload_hash"), "payload hash")
    matches = []
    for raw in rows(reply):
        row = flat(raw)
        if not isinstance(row, dict):
            continue
        if (row.get("address") == request["canonical_address"]
                and row.get("revision", row.get("content_hash")) == request["canonical_revision"]
                and row.get("content_hash", row.get("payload_hash")) == request["payload_hash"]):
            matches.append(row)
    if len(matches) != 1:
        raise ValueError("canonical owner hydration must yield exactly one matching current row")
    result = {**matches[0], "canonical_address": request["canonical_address"],
              "canonical_revision": request["canonical_revision"],
              "payload_hash": request["payload_hash"], "rank_score": request.get("rank_score"),
              "rank_provenance_ref": request.get("rank_provenance_ref"),
              "authority_provenance_ref": request.get("authority_provenance_ref"),
              "descriptor_revision": require_canonical_multihash(
                  request.get("descriptor_revision"), "semantic index descriptor revision"
              ),
              "model_provenance_ref": request.get("model_provenance_ref")}
    if not isinstance(result["model_provenance_ref"], str) or not result["model_provenance_ref"]:
        raise ValueError("model provenance reference is required")
    for key in (
        "owner_target", "schema_ref", "schema_digest", "surface_ref",
        "title", "description", "input_schema",
    ):
        if request.get(key) is not None:
            result[key] = request[key]
    return {"item": result}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-json", required=True)
    parser.add_argument("--owner-reply-json", required=True)
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()
    result = hydrate(load(args.request_json), load(args.owner_reply_json))
    Path(args.output_json).write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
