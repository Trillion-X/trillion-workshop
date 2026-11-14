#!/usr/bin/env python3
"""Resolve one addressed result policy and own ranked current-item hydration.

This leaf keeps result-policy selection, canonical hydration planning, and
budget enforcement inside Meaning Search. Consumers submit a query and consume
the already bounded, already hydrated ordered result set.
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


def write(path: str, value) -> None:
    Path(path).write_text(
        json.dumps(value, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )


def nonempty(value, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def positive_integer(value, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"{label} must be a positive integer")
    return value


def flatten(row):
    if not isinstance(row, dict):
        return row
    payload = row.get("payload")
    if isinstance(payload, dict):
        return {**row, **payload}
    return row


def rows(value) -> list:
    if isinstance(value, list):
        return value
    if not isinstance(value, dict):
        return []
    for key in ("items", "results"):
        if isinstance(value.get(key), list):
            return value[key]
    for key in ("output", "result"):
        nested = rows(value.get(key))
        if nested:
            return nested
    return []


def policy_ref(policy: dict) -> str:
    explicit = policy.get("ref")
    if isinstance(explicit, str) and explicit:
        return explicit
    return f"semantic-result-policy:{nonempty(policy.get('id'), 'policy id')}"


def resolve_policy(request: dict, policy_reply) -> dict:
    requested_ref = nonempty(request.get("result_policy_ref"), "result policy reference")
    matches = [
        flatten(row)
        for row in rows(policy_reply)
        if isinstance(flatten(row), dict)
        and flatten(row).get("kind") == "semantic-result-policy"
        and policy_ref(flatten(row)) == requested_ref
    ]
    if len(matches) != 1:
        raise ValueError("result policy reference must resolve to exactly one current record")
    policy = matches[0]
    return {
        "ref": requested_ref,
        "max_result_count": positive_integer(
            policy.get("max_result_count"), "policy max result count"
        ),
        "max_schema_bytes_per_result": positive_integer(
            policy.get("max_schema_bytes_per_result"),
            "policy max schema bytes per result",
        ),
        "total_prompt_budget_bytes": positive_integer(
            policy.get("total_prompt_budget_bytes"),
            "policy total prompt budget bytes",
        ),
    }


def prepare(request: dict, policy_reply) -> dict:
    index_id = nonempty(request.get("index_id"), "index id")
    owner_query_target = nonempty(
        request.get("owner_query_target"), "owner query target"
    )
    query_text = request.get("query_text")
    query_vector = request.get("query_vector_base64")
    if bool(isinstance(query_text, str) and query_text) == bool(
        isinstance(query_vector, str) and query_vector
    ):
        raise ValueError("exactly one query_text or query_vector_base64 is required")
    policy = resolve_policy(request, policy_reply)
    query_input = {
        "index_id": index_id,
        "limit": policy["max_result_count"],
    }
    if isinstance(query_text, str) and query_text:
        query_input["query_text"] = query_text
    else:
        query_input["query_vector_base64"] = query_vector
    return {
        "policy": policy,
        "owner_query_target": owner_query_target,
        "query_input": query_input,
    }


def canonical_ranked_item(raw: dict, plan: dict) -> dict:
    address = nonempty(
        raw.get("canonical_address", raw.get("address")), "canonical address"
    )
    revision = require_canonical_multihash(
        raw.get("canonical_revision", raw.get("revision")), "canonical revision"
    )
    payload_hash = require_canonical_multihash(
        raw.get("payload_hash"), "canonical payload hash"
    )
    descriptor_revision = require_canonical_multihash(
        raw.get("descriptor_revision"), "semantic index descriptor revision"
    )
    model_provenance_ref = nonempty(
        raw.get("model_provenance_ref"), "model provenance reference"
    )
    score = raw.get("rank_score", raw.get("score"))
    if not isinstance(score, (int, float)) or isinstance(score, bool):
        raise ValueError("rank score must be numeric")
    index_id = nonempty(plan["query_input"].get("index_id"), "index id")
    item = {
        **raw,
        "canonical_address": address,
        "canonical_revision": revision,
        "payload_hash": payload_hash,
        "descriptor_revision": descriptor_revision,
        "model_provenance_ref": model_provenance_ref,
        "rank_score": float(score),
        "rank_provenance_ref": nonempty(
            raw.get("rank_provenance_ref")
            or f"semantic-index-descriptor:{index_id}",
            "rank provenance reference",
        ),
        "owner_query_target": plan["owner_query_target"],
        "owner_query": {
            "operation": "find-current-items",
            "in": "published-record",
            "addresses": [address],
            "include": ["address", "content_hash", "payload"],
        },
    }
    item.pop("address", None)
    item.pop("revision", None)
    item.pop("score", None)
    return item


def plan_hydrations(plan: dict, ranked_reply) -> dict:
    candidates = rows(ranked_reply)
    max_count = positive_integer(
        plan.get("policy", {}).get("max_result_count"), "policy max result count"
    )
    if len(candidates) > max_count:
        raise ValueError("ranked result count exceeds the resolved result policy")
    requests = [canonical_ranked_item(item, plan) for item in candidates]
    identities = [
        (item["canonical_address"], item["canonical_revision"], item["payload_hash"])
        for item in requests
    ]
    if len(set(identities)) != len(identities):
        raise ValueError("ranked results contain duplicate canonical identities")
    return {"requests": requests, "candidate_count": len(requests)}


def hydrated_item(raw):
    if not isinstance(raw, dict):
        raise ValueError("hydration result must be an object")
    for candidate in (
        raw,
        raw.get("item"),
        raw.get("result"),
        raw.get("output"),
    ):
        if isinstance(candidate, dict) and isinstance(candidate.get("item"), dict):
            return candidate["item"]
        if (
            isinstance(candidate, dict)
            and isinstance(candidate.get("canonical_address"), str)
        ):
            return candidate
    raise ValueError("hydration result does not contain one canonical item")


def finalize(plan: dict, hydration_plan: dict, hydration_reply) -> dict:
    requests = hydration_plan.get("requests")
    if not isinstance(requests, list):
        raise ValueError("hydration plan requests are invalid")
    hydrated_rows = rows(hydration_reply)
    if not hydrated_rows and isinstance(hydration_reply, list):
        hydrated_rows = hydration_reply
    if len(hydrated_rows) != len(requests):
        raise ValueError("ranked result hydration is incomplete")
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        raise ValueError("resolved policy is invalid")
    schema_bytes = 0
    accepted = []
    for expected, raw in zip(requests, hydrated_rows):
        item = hydrated_item(raw)
        for key in (
            "canonical_address",
            "canonical_revision",
            "payload_hash",
            "descriptor_revision",
            "model_provenance_ref",
        ):
            if item.get(key) != expected.get(key):
                raise ValueError(f"hydrated result changed ranked {key}")
        schema = item.get("input_schema")
        if schema is not None:
            encoded_size = len(
                json.dumps(
                    schema, separators=(",", ":"), ensure_ascii=False
                ).encode("utf-8")
            )
            if encoded_size > policy["max_schema_bytes_per_result"]:
                continue
            if schema_bytes + encoded_size > policy["total_prompt_budget_bytes"]:
                continue
            schema_bytes += encoded_size
        accepted.append(item)
    if len(accepted) > policy["max_result_count"]:
        raise ValueError("bounded results exceed the resolved result policy")
    return {
        "items": accepted,
        "policy_ref": policy["ref"],
        "candidate_count": len(requests),
        "returned_count": len(accepted),
        "schema_bytes": schema_bytes,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode", choices=("prepare", "plan-hydrations", "finalize"), required=True
    )
    parser.add_argument("--request-json")
    parser.add_argument("--policy-reply-json")
    parser.add_argument("--plan-json")
    parser.add_argument("--ranked-reply-json")
    parser.add_argument("--hydration-plan-json")
    parser.add_argument("--hydration-reply-json")
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()
    if args.mode == "prepare":
        result = prepare(load(args.request_json), load(args.policy_reply_json))
    elif args.mode == "plan-hydrations":
        result = plan_hydrations(load(args.plan_json), load(args.ranked_reply_json))
    else:
        result = finalize(
            load(args.plan_json),
            load(args.hydration_plan_json),
            load(args.hydration_reply_json),
        )
    write(args.output_json, result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
