#!/usr/bin/env python3
"""Create one atomic Envelope write-set for a semantic-index convergence plan.

This composition leaf joins the package's existing generic fact-row producer
and ANN owner computation.  It does not publish facts, mutate Envelope state,
or return raw rows/state: process-engine owns the one atomic commit of the
manifest and its relative payload files.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from envelope_write_set import write_envelope_write_set


def _load_sibling(module_name: str, filename: str):
    spec = importlib.util.spec_from_file_location(module_name, HERE / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ann_index = _load_sibling("meaning_search_ann_index", "ann-index.py")
embedding_facts = _load_sibling(
    "meaning_search_embedding_facts", "make-embedding-facts-from-command-output.py"
)


def read_object(path: str, name: str) -> dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def _retraction_rows(plan: dict[str, Any], index_id: str, accepted_subjects: list[str], state: dict) -> list[dict[str, Any]]:
    accepted = set(accepted_subjects)
    rows: list[dict[str, Any]] = []
    for mutation in plan.get("retracts", []):
        if not isinstance(mutation, dict):
            raise ValueError("convergence plan retracts must be an array of objects")
        subject_id = mutation.get("content_address")
        if subject_id in accepted:
            # _facts_for_retraction starts with the shared ANN-state rows. The
            # combined output publishes that singleton once below.
            rows.extend(ann_index._facts_for_retraction(index_id, subject_id, state)[4:])
    return rows


def combined_rows(
    plan: dict[str, Any],
    embedding_output: dict[str, Any],
    descriptor: dict[str, Any],
    state: dict[str, Any],
    index_id: str,
) -> tuple[list[dict[str, Any]], int]:
    if not isinstance(index_id, str) or not index_id:
        raise ValueError("index_id must be a non-empty string")
    params = descriptor.get("ann_params")
    if not isinstance(params, dict):
        raise ValueError("descriptor ann_params must be an object")
    vectors, embedding_rows = embedding_facts.batch_fact_rows(
        plan, embedding_output, descriptor
    )
    next_state, mutation_count, accepted_retractions = ann_index._apply_plan_with_outcomes(
        state, plan, vectors, params, index_id
    )
    rows = [
        *embedding_rows,
        *ann_index._facts_for_state(index_id, next_state),
        *_retraction_rows(plan, index_id, accepted_retractions, next_state),
    ]
    return rows, mutation_count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index-id", required=True)
    parser.add_argument("--plan-json", required=True)
    parser.add_argument("--embedding-output-json", required=True)
    parser.add_argument("--descriptor-json", required=True)
    parser.add_argument("--state-json", required=True)
    parser.add_argument("--output-write-set-json", required=True)
    args = parser.parse_args(argv)
    plan = read_object(args.plan_json, "plan")
    rows, mutation_count = combined_rows(
        plan,
        read_object(args.embedding_output_json, "embedding output"),
        read_object(args.descriptor_json, "descriptor"),
        read_object(args.state_json, "state"),
        args.index_id,
    )
    write_envelope_write_set(rows, args.output_write_set_json)
    print(f"[meaning-search] wrote atomic semantic-index write set: {len(rows)} writes, {mutation_count} mutations")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - CLI boundary must fail closed
        print(f"[meaning-search] error: {exc}", file=sys.stderr)
        raise SystemExit(1)
