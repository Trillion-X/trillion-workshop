#!/usr/bin/env python3
#
# File: packages/content-generation/do-work/process-scripts/compose-run-request.py
#
# =============================================================================
# PURPOSE — BLIND INSTRUCTION ASSEMBLER (Physics, zero Society)
# =============================================================================
#
# Assemble the ONE thing an AI-records-producer run needs — an `instruction_text`
# string — from a self-describing `content-generation.recipe` (DATA) + the
# selected work item + resolved instruction-block bodies + retrieved grounding.
#
# This script owns NO domain vocabulary, NO prompt text, NO model/CLI call. It is
# a generic TEMPLATE INTERPRETER: the recipe's `instruction_plan.prompt_template`
# is an ORDERED list of self-describing segments, and this script renders each
# segment from DATA. Every substantive instruction (persona, style, cite-rules,
# BLUF/FAQ format, the output JSON shape) lives in the recipe's DATA (instruction
# blocks + output_contract.schema), never here. Swap the recipe DATA -> a cooking
# blog, a legal brief, a changelog -- with ZERO change to this file.
#
# Emits the exact input shape `action:run-ai-records-production` consumes:
#   { instruction_text, output_kind, request_id, [model], [agent_ref],
#     [target_group_ref], [parameters] }
#
# =============================================================================
# SEGMENT GRAMMAR (self-describing DATA -- the ONLY thing this script interprets)
# =============================================================================
#
#   {"block_ref": "<id>"}              -> the resolved instruction-block body
#   {"literal": "<text>"}             -> DATA text verbatim (a structural label)
#   {"slot": "work_item", "path":k}   -> work_item[k] (the topic/keyword/etc)
#   {"slot": "schema"}                -> output_contract.schema rendered as text
#   {"slot": "grounding", "label":l}  -> `l` + the grounding JSON, when grounding
#                                        is non-empty; empty string otherwise
#   {"slot": "conditional_grounding",
#     "when_present": [<segments>],
#     "when_absent":  [<segments>]}   -> recursively render one branch, chosen by
#                                        whether grounding is present
#   {"slot": "conditional_value",
#     "path": <work_item key>,
#     "when_present": [<segments>],
#     "when_absent":  [<segments>]}   -> branch on presence of a work_item value
#
# Empty rendered segments are dropped from the final join (matches the reference
# engine's behavior: an absent grounding section contributes nothing).
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
# 1. No domain string, no prompt text, no output-shape literal in this file.
# 2. Never executes an AI CLI or any OS process -- it only assembles text.
# 3. Pure stdlib. Deterministic. No network.
# 4. Unknown segment kinds are skipped (fail-open to empty), never crash.

from __future__ import annotations

import argparse
import json
import pathlib
from typing import Any


def as_string(value: Any) -> str:
    return value if isinstance(value, str) else ""


def read_json_arg(value: str, fallback: Any) -> Any:
    try:
        parsed = json.loads(value) if value else fallback
    except Exception:
        return fallback
    return parsed


def grounding_is_present(grounding: Any) -> bool:
    """A grounding payload counts as present only when it carries at least one
    excerpt. Mirrors the reference engine's `g in ('', '[]', 'null', '{}')` test,
    but structurally (on the parsed value) instead of on raw text."""
    if isinstance(grounding, list):
        return len(grounding) > 0
    if isinstance(grounding, dict):
        return len(grounding) > 0
    return False


def render_schema(recipe: dict[str, Any]) -> str:
    """The output shape the model must return. Pure DATA off the recipe's
    output_contract -- this script never names a field of it."""
    contract = recipe.get("output_contract")
    if not isinstance(contract, dict):
        return ""
    schema = contract.get("schema")
    if isinstance(schema, str):
        return schema
    if schema is None:
        return ""
    # A structured schema is rendered as pretty JSON (a human/model-legible shape).
    try:
        return json.dumps(schema, ensure_ascii=False, indent=2)
    except Exception:
        return ""


def render_grounding(grounding: Any, label: str) -> str:
    """Render the grounding section: the DATA `label` then the grounding JSON.
    Empty when there is no grounding (dropped from the join)."""
    if not grounding_is_present(grounding):
        return ""
    try:
        body = json.dumps(grounding, ensure_ascii=False)
    except Exception:
        body = ""
    parts = [p for p in (label, body) if p]
    return "\n".join(parts)


def render_segment(
    segment: Any,
    *,
    recipe: dict[str, Any],
    work_item: dict[str, Any],
    blocks_by_id: dict[str, str],
    grounding: Any,
) -> str:
    """Render ONE self-describing segment to text. Generic dispatch on the
    segment's declared shape -- never on a domain identity."""
    if isinstance(segment, str):
        return segment
    if not isinstance(segment, dict):
        return ""

    block_ref = as_string(segment.get("block_ref"))
    if block_ref:
        return blocks_by_id.get(block_ref, "")

    literal = segment.get("literal")
    if isinstance(literal, str):
        return literal

    slot = as_string(segment.get("slot"))
    if slot == "work_item":
        key = as_string(segment.get("path"))
        value = work_item.get(key) if key else None
        if isinstance(value, str):
            return value.strip()
        if value is None:
            return ""
        try:
            return json.dumps(value, ensure_ascii=False)
        except Exception:
            return ""
    if slot == "schema":
        return render_schema(recipe)
    if slot == "grounding":
        return render_grounding(grounding, as_string(segment.get("label")))
    if slot == "conditional_grounding":
        branch = segment.get("when_present") if grounding_is_present(grounding) else segment.get("when_absent")
        return render_segments(
            branch if isinstance(branch, list) else [],
            recipe=recipe, work_item=work_item, blocks_by_id=blocks_by_id, grounding=grounding,
        )
    if slot == "conditional_value":
        key = as_string(segment.get("path"))
        present = bool(work_item.get(key)) if key else False
        branch = segment.get("when_present") if present else segment.get("when_absent")
        return render_segments(
            branch if isinstance(branch, list) else [],
            recipe=recipe, work_item=work_item, blocks_by_id=blocks_by_id, grounding=grounding,
        )
    # Unknown segment kind: fail-open to empty (never crash the run).
    return ""


def render_segments(
    segments: list[Any],
    *,
    recipe: dict[str, Any],
    work_item: dict[str, Any],
    blocks_by_id: dict[str, str],
    grounding: Any,
) -> str:
    """Render an ordered segment list, dropping empties, joined by newline."""
    rendered = [
        render_segment(seg, recipe=recipe, work_item=work_item, blocks_by_id=blocks_by_id, grounding=grounding)
        for seg in segments
    ]
    return "\n".join(part for part in rendered if part != "")


def index_blocks(blocks_rows: Any) -> dict[str, str]:
    """Fold ai-instruction-block rows (find-current-items published-record rows,
    flat or nested-under-payload) into {id: body}. Generic -- names only the two
    universal ai-instruction-block fields (`id`, `body`), no domain."""
    out: dict[str, str] = {}
    if not isinstance(blocks_rows, list):
        return out
    for row in blocks_rows:
        if not isinstance(row, dict):
            continue
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else row
        if not isinstance(payload, dict):
            continue
        if payload.get("kind") != "ai-instruction-block":
            continue
        block_id = as_string(payload.get("id"))
        body = payload.get("body")
        if block_id and isinstance(body, str):
            out[block_id] = body
    return out


def main() -> int:
    p = argparse.ArgumentParser(description="Assemble an ai-records-producer request from a content-generation recipe.")
    p.add_argument("--recipe-json", required=True, help="The content-generation.recipe object (DATA).")
    p.add_argument("--work-item-json", required=True, help="The selected work item {topic/keyword/slug/query/...}.")
    p.add_argument("--instruction-blocks-json", default="[]", help="ai-instruction-block published-record rows.")
    p.add_argument("--grounding-json", default="[]", help="Retrieved/provided grounding excerpts (default empty).")
    p.add_argument("--request-id", default="", help="Producer result address key for this run.")
    p.add_argument("--output-json", required=True)
    args = p.parse_args()

    recipe = read_json_arg(args.recipe_json, {})
    if not isinstance(recipe, dict):
        recipe = {}
    work_item = read_json_arg(args.work_item_json, {})
    if not isinstance(work_item, dict):
        work_item = {}
    blocks_by_id = index_blocks(read_json_arg(args.instruction_blocks_json, []))
    grounding = read_json_arg(args.grounding_json, [])

    plan = recipe.get("instruction_plan") if isinstance(recipe.get("instruction_plan"), dict) else {}
    template = plan.get("prompt_template")
    if not isinstance(template, list):
        template = []

    instruction_text = render_segments(
        template, recipe=recipe, work_item=work_item, blocks_by_id=blocks_by_id, grounding=grounding
    )

    producer = recipe.get("ai_producer_target") if isinstance(recipe.get("ai_producer_target"), dict) else {}
    request: dict[str, Any] = {
        "input_refs": [],
        "instruction_text": instruction_text,
        "output_kind": as_string(producer.get("output_kind")) or "note",
        "request_id": as_string(args.request_id) or as_string(work_item.get("request_id")),
    }
    retrieval = recipe.get("context_retrieval")
    refs_field = as_string(retrieval.get("input_refs_field")) if isinstance(retrieval, dict) else ""
    if refs_field:
        refs = work_item.get(refs_field)
        if not isinstance(refs, list) or not refs:
            raise ValueError("Saved evidence references are required.")
        request["input_refs"] = refs
    # Optional pass-throughs (DATA on the recipe): model / agent selection routing
    # and an open parameter bag. The producer treats each as optional; absent keys
    # simply are not sent. We only emit keys that carry a value (no empty noise).
    for key in ("model", "agent_ref"):
        value = as_string(producer.get(key))
        if value:
            request[key] = value
    target_group_ref = producer.get("target_group_ref")
    if isinstance(target_group_ref, str) and target_group_ref:
        request["target_group_ref"] = target_group_ref
    parameters = producer.get("parameters")
    if isinstance(parameters, dict) and parameters:
        request["parameters"] = parameters

    pathlib.Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(args.output_json).write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    # Also emit on stdout so a `return`/compute-arg binding can read it directly.
    print(json.dumps(request, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
