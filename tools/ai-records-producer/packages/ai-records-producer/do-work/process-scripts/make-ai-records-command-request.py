#!/usr/bin/env python3
#
# File: packages/ai-records-producer/do-work/process-scripts/make-ai-records-command-request.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# Build a direct compute.process descriptor for an ai-records-producer run.
# Resolves the AI CLI from two data sources (in priority order):
#
#   1. selected-agent rows → ai-agent-profile rows  (canonical SSOT)
#   2. provider rows + cli-registry rows             (provider-primary fallback)
#
# The wrap instruction text is DATA (passed in as --instruction-text, which the
# workflow has already assembled from the wrap_instruction_ref). No hardcoded
# prompt text, model names, provider names, or CLI names appear here.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. Never executes an AI CLI or any OS process.
# 2. No hardcoded model/provider/CLI names — all resolved from DATA rows.
# 3. No fabricated output — if no CLI is resolvable, raises RuntimeError.
# 4. Agent profile launch takes priority over provider-primary.
# 5. Pure stdlib — no third-party dependencies.

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
from typing import Any


# These are producer-wide safety ceilings, not a caller-controlled budget. A
# request may choose tighter limits through DATA, but it may never raise these
# ceilings. The snapshot is deliberately small enough to be reviewed and
# recorded with the request before any provider transport is selected.
MAX_ADDRESSED_INPUT_ITEMS = 16
MAX_ADDRESSED_INPUT_ITEM_BYTES = 32 * 1024
MAX_ADDRESSED_INPUT_TOTAL_BYTES = 128 * 1024
ADDRESSED_INPUT_SNAPSHOT_KIND = "ai-records-producer.addressed-input-snapshot/v1"

# A selected profile may compose several instruction blocks, but prompt assembly
# is never allowed to become an unbounded argv/http payload. These ceilings are
# deliberately independent from addressed-input limits: instructions are trusted
# owner configuration, while addressed inputs are per-request evidence.
MAX_PROFILE_INSTRUCTION_ITEMS = 64
MAX_PROFILE_INSTRUCTION_ITEM_BYTES = 64 * 1024
MAX_PROFILE_INSTRUCTION_TOTAL_BYTES = 256 * 1024
# Large profile selections never cross argv or an HTTP body. They are assembled
# by the instruction owner, stored in CAS, and mounted into a process-shaped
# transport by hash. Keep a separate hard ceiling so this lane cannot silently
# turn into an unbounded mount while preserving the tighter inline ceiling above.
MAX_MATERIALIZED_PROFILE_INSTRUCTION_TOTAL_BYTES = 16 * 1024 * 1024
PROFILE_INSTRUCTION_SNAPSHOT_KIND = "ai-records-producer.profile-instruction-snapshot/v1"
PROFILE_INSTRUCTION_SELECTION_KIND = "ai-agent-profile.instruction-selection/v1"
DEFAULT_SYSTEM_PROMPT_MOUNT_PATH = ".bitfield-harness/system-prompt.md"


# ---------------------------------------------------------------------------
# Shared helpers (cloned from make-prompt-to-variations-command-request.py)
# ---------------------------------------------------------------------------

def as_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def scalar_text(value: Any) -> str:
    """Render an open-parameter value as launch-template text. Strings pass
    through; bools/numbers use their canonical text; structures serialize to
    compact JSON (self-describing, harmless inside a template placeholder)."""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return ""


def parse_rows(value: str) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(value) if value else []
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    # A workflow action may compose several canonical owner queries and return
    # their ordered row arrays through a one-iteration definition loop. Flatten
    # arrays and the action's explicit `items` envelope only; record objects
    # remain opaque and no DATA fields are interpreted here.
    flattened: list[Any] = []
    pending: list[Any] = list(reversed(parsed))
    while pending:
        item = pending.pop()
        if isinstance(item, list):
            pending.extend(reversed(item))
        elif isinstance(item, dict) and set(item) == {"items"}:
            pending.append(item["items"])
        else:
            flattened.append(item)
    return flattened


def parse_optional_object(value: str, label: str) -> dict[str, Any] | None:
    """Parse an optional JSON object without turning malformed owner data into absence."""
    try:
        parsed = json.loads(value) if value else None
    except Exception as error:
        raise RuntimeError(f"{label} must be valid JSON") from error
    if parsed is None:
        return None
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{label} must be an object or null")
    return parsed


def canonical_json(value: Any) -> str:
    """Stable JSON is the only prompt representation we hash and dispatch."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def nonempty_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise RuntimeError(f"{label} must be a non-empty trimmed string")
    if any(ord(character) < 32 for character in value):
        raise RuntimeError(f"{label} must not contain control characters")
    return value


def extract_input_refs(input_obj: dict[str, Any]) -> list[Any]:
    """Accept the normal action shape and its generic nested-input envelope.

    Trigger/workflow callers commonly preserve their original action input under
    `input`; accepting that envelope is structural, not a founder/domain branch.
    Supplying both locations is ambiguous and therefore rejected unless they are
    byte-for-byte the same JSON value.
    """
    direct = input_obj.get("input_refs")
    nested_input = input_obj.get("input")
    nested = nested_input.get("input_refs") if isinstance(nested_input, dict) else None
    if direct is not None and nested is not None and canonical_json(direct) != canonical_json(nested):
        raise RuntimeError("input_refs are ambiguous between direct and nested action input")
    selected = direct if direct is not None else nested
    if selected is None:
        return []
    if not isinstance(selected, list):
        raise RuntimeError("input_refs must be an ordered list")
    return selected


def bounded_snapshot_limits(input_obj: dict[str, Any]) -> dict[str, int]:
    """Read optional DATA limits, allowing only more restrictive values."""
    raw = input_obj.get("input_snapshot_limits")
    if raw is None and isinstance(input_obj.get("input"), dict):
        raw = input_obj["input"].get("input_snapshot_limits")
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise RuntimeError("input_snapshot_limits must be an object when supplied")
    defaults = {
        "max_items": MAX_ADDRESSED_INPUT_ITEMS,
        "max_item_bytes": MAX_ADDRESSED_INPUT_ITEM_BYTES,
        "max_total_bytes": MAX_ADDRESSED_INPUT_TOTAL_BYTES,
    }
    limits: dict[str, int] = {}
    for key, ceiling in defaults.items():
        value = raw.get(key, ceiling)
        if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > ceiling:
            raise RuntimeError(f"input_snapshot_limits.{key} must be an integer from 1 to {ceiling}")
        limits[key] = value
    return limits


def normalized_row_payload(raw: dict[str, Any]) -> Any:
    """Keep the addressed record content, never transient read-envelope fields."""
    if "payload" in raw:
        return raw.get("payload")
    ignored = {
        "address", "canonical_address", "revision", "current_revision",
        "content_hash", "payload_hash", "found", "authorized", "retracted",
        "remove", "provenance", "authorization_provenance_ref",
    }
    return {key: value for key, value in raw.items() if key not in ignored}


def flatten_addressed_row(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise RuntimeError("addressed input owner reply contains a malformed row")
    # Keep envelope metadata (address/hash/authorization) while letting a
    # published-record payload contribute its user content.
    payload = raw.get("payload")
    if isinstance(payload, dict):
        # Transport envelope metadata wins over payload fields. A source record
        # is allowed to contain a user field named `content_hash` or `revision`;
        # it must never shadow the current-owner metadata we validate.
        return {**payload, **raw, "payload": payload}
    return raw


def normalized_input_ref(raw: Any) -> dict[str, str | None]:
    if isinstance(raw, str):
        return {"canonical_address": nonempty_text(raw, "input reference address"),
                "expected_revision": None, "expected_content_hash": None}
    if not isinstance(raw, dict):
        raise RuntimeError("every input_ref must be an address string or an addressed reference object")
    address = raw.get("canonical_address", raw.get("address"))
    expected_revision = raw.get("expected_revision", raw.get("revision"))
    expected_hash = raw.get("expected_content_hash", raw.get("content_hash", raw.get("payload_hash")))
    return {
        "canonical_address": nonempty_text(address, "input reference canonical_address"),
        "expected_revision": nonempty_text(expected_revision, "input reference expected_revision") if expected_revision is not None else None,
        "expected_content_hash": nonempty_text(expected_hash, "input reference expected_content_hash") if expected_hash is not None else None,
    }


def hydrate_addressed_inputs(input_obj: dict[str, Any], owner_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Create the immutable, bounded evidence snapshot used by the provider.

    The owner query is expected to enforce read authority. This function still
    rejects an explicit unauthorized/retracted/missing row, duplicate addresses,
    stale caller pins, malformed metadata, and every size violation. It never
    performs I/O and it does not interpret any consumer-domain payload.
    """
    refs = [normalized_input_ref(raw) for raw in extract_input_refs(input_obj)]
    limits = bounded_snapshot_limits(input_obj)
    if len(refs) > limits["max_items"]:
        raise RuntimeError("addressed input item count exceeds input snapshot limit")
    if not refs:
        if owner_rows:
            raise RuntimeError("addressed input owner rows supplied without input_refs")
        return {
            "kind": ADDRESSED_INPUT_SNAPSHOT_KIND,
            "items": [], "item_count": 0, "content_bytes": 0, "limits": limits,
            "snapshot_hash": sha256_text("[]"),
        }

    by_address: dict[str, list[dict[str, Any]]] = {}
    for raw in owner_rows:
        row = flatten_addressed_row(raw)
        address_value = row.get("canonical_address", row.get("address"))
        if not isinstance(address_value, str):
            continue
        by_address.setdefault(address_value, []).append(row)

    items: list[dict[str, Any]] = []
    total_bytes = 0
    seen_refs: set[str] = set()
    for position, ref in enumerate(refs):
        address = ref["canonical_address"]
        if address in seen_refs:
            raise RuntimeError("addressed input references must not contain duplicate canonical addresses")
        seen_refs.add(address)
        matches = by_address.get(address, [])
        if len(matches) != 1:
            raise RuntimeError(f"addressed input must resolve exactly one current authorized row: {address}")
        row = matches[0]
        if row.get("found") is False:
            raise RuntimeError(f"addressed input is missing: {address}")
        if row.get("authorized") is False or row.get("authorization") is False:
            raise RuntimeError(f"addressed input is unauthorized: {address}")
        if row.get("retracted") is True or row.get("remove") is True or row.get("payload") is None:
            raise RuntimeError(f"addressed input is retracted: {address}")
        revision = row.get("current_revision", row.get("revision", row.get("content_hash", row.get("payload_hash"))))
        content_hash = row.get("content_hash", row.get("payload_hash"))
        revision = nonempty_text(revision, f"addressed input revision for {address}")
        content_hash = nonempty_text(content_hash, f"addressed input content hash for {address}")
        if ref["expected_revision"] is not None and ref["expected_revision"] != revision:
            raise RuntimeError(f"addressed input is stale at {address}: expected revision does not match current")
        if ref["expected_content_hash"] is not None and ref["expected_content_hash"] != content_hash:
            raise RuntimeError(f"addressed input is stale at {address}: expected content hash does not match current")
        content = normalized_row_payload(row)
        if content is None:
            raise RuntimeError(f"addressed input is retracted: {address}")
        try:
            normalized_content = canonical_json(content)
        except (TypeError, ValueError) as error:
            raise RuntimeError(f"addressed input content is not JSON-normalizable: {address}") from error
        content_bytes = len(normalized_content.encode("utf-8"))
        if content_bytes > limits["max_item_bytes"]:
            raise RuntimeError(f"addressed input exceeds per-item byte limit: {address}")
        if total_bytes + content_bytes > limits["max_total_bytes"]:
            raise RuntimeError("addressed inputs exceed total byte limit")
        total_bytes += content_bytes
        provenance = row.get("provenance")
        if provenance is not None and not isinstance(provenance, (dict, list, str)):
            raise RuntimeError(f"addressed input provenance is malformed: {address}")
        items.append({
            "position": position,
            "canonical_address": address,
            "expected_revision": revision,
            "expected_content_hash": content_hash,
            "normalized_content_hash": sha256_text(normalized_content),
            "content": content,
            "content_bytes": content_bytes,
            "provenance": provenance if provenance is not None else {"source": "current-owner-read"},
            "authorization_provenance_ref": row.get("authorization_provenance_ref"),
        })
    snapshot_body = canonical_json(items)
    return {
        "kind": ADDRESSED_INPUT_SNAPSHOT_KIND,
        "items": items,
        "item_count": len(items),
        "content_bytes": total_bytes,
        "limits": limits,
        "snapshot_hash": sha256_text(snapshot_body),
    }


def snapshot_prompt_suffix(snapshot: dict[str, Any]) -> str:
    if not snapshot["items"]:
        return ""
    return "\n\nAddressed input snapshot (immutable, ordered, and source-bound):\n" + canonical_json(snapshot)


def profile_payload(row: Any) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else row
    return payload if isinstance(payload, dict) and payload.get("kind") == "ai-agent-profile" else None


def instruction_payload(row: Any) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else row
    return payload if isinstance(payload, dict) and payload.get("kind") == "ai-instruction-block" else None


def normalized_instruction_ref(raw: Any) -> dict[str, str | None]:
    if isinstance(raw, str):
        return {
            "id": nonempty_text(raw, "profile instruction reference"),
            "expected_revision": None,
            "expected_content_hash": None,
        }
    if not isinstance(raw, dict):
        raise RuntimeError("every profile instruction_ref must be an id string or pinned reference object")
    instruction_id = raw.get("id", raw.get("ref", raw.get("instruction_ref")))
    expected_revision = raw.get("expected_revision", raw.get("revision_ref", raw.get("revision")))
    expected_content_hash = raw.get(
        "expected_content_hash", raw.get("content_hash", raw.get("body_hash"))
    )
    return {
        "id": nonempty_text(instruction_id, "profile instruction reference id"),
        "expected_revision": (
            nonempty_text(expected_revision, "profile instruction expected_revision")
            if expected_revision is not None else None
        ),
        "expected_content_hash": (
            nonempty_text(expected_content_hash, "profile instruction expected_content_hash")
            if expected_content_hash is not None else None
        ),
    }


def validate_profile_instruction_selection(
    profile: dict[str, Any], normalized_refs: list[dict[str, str | None]]
) -> dict[str, Any] | None:
    """Validate optional, versioned inclusion/exclusion lineage owned by a profile.

    The descriptor is DATA, not a product branch. It proves which candidates were
    included or excluded and binds the decision to one source-set revision. The
    producer remains the enforcement point because it already owns prompt bounds.
    Profiles without the descriptor retain their existing behavior.
    """
    raw = profile.get("instruction_selection")
    if raw is None:
        return None
    if not isinstance(raw, dict) or raw.get("kind") != PROFILE_INSTRUCTION_SELECTION_KIND:
        raise RuntimeError("profile instruction_selection kind is missing or unsupported")

    revision = nonempty_text(raw.get("revision"), "profile instruction_selection revision")
    source_set_ref = nonempty_text(
        raw.get("source_set_ref"), "profile instruction_selection source_set_ref"
    )
    resolve_mode = raw.get("resolve_mode")
    if resolve_mode is not None:
        resolve_mode = nonempty_text(
            resolve_mode, "profile instruction_selection resolve_mode"
        )
        if resolve_mode != "by-set-live":
            raise RuntimeError("profile instruction_selection resolve_mode is unsupported")
    max_total_bytes = raw.get("max_total_bytes")
    byte_ceiling = (
        MAX_MATERIALIZED_PROFILE_INSTRUCTION_TOTAL_BYTES
        if resolve_mode == "by-set-live"
        else MAX_PROFILE_INSTRUCTION_TOTAL_BYTES
    )
    if (
        not isinstance(max_total_bytes, int)
        or isinstance(max_total_bytes, bool)
        or max_total_bytes <= 0
        or max_total_bytes > byte_ceiling
    ):
        ceiling_label = (
            "materialized delivery ceiling"
            if resolve_mode == "by-set-live" else "producer ceiling"
        )
        raise RuntimeError(
            "profile instruction_selection max_total_bytes must be a positive integer within the "
            + ceiling_label
        )

    raw_candidates = raw.get("candidates")
    if not isinstance(raw_candidates, list) or not raw_candidates:
        raise RuntimeError("profile instruction_selection candidates must be a non-empty ordered list")
    if len(raw_candidates) > 256:
        raise RuntimeError("profile instruction_selection candidate count exceeds hard limit")

    candidates: list[dict[str, str]] = []
    seen: set[str] = set()
    included: list[str] = []
    for raw_candidate in raw_candidates:
        if not isinstance(raw_candidate, dict):
            raise RuntimeError("profile instruction_selection candidate must be an object")
        instruction_ref = nonempty_text(
            raw_candidate.get("instruction_ref"),
            "profile instruction_selection candidate instruction_ref",
        )
        if instruction_ref in seen:
            raise RuntimeError("profile instruction_selection candidates must not contain duplicates")
        seen.add(instruction_ref)
        disposition = raw_candidate.get("disposition")
        if disposition not in {"include", "exclude"}:
            raise RuntimeError(
                "profile instruction_selection candidate disposition must be include or exclude"
            )
        reason_ref = nonempty_text(
            raw_candidate.get("reason_ref"),
            "profile instruction_selection candidate reason_ref",
        )
        candidates.append({
            "instruction_ref": instruction_ref,
            "disposition": disposition,
            "reason_ref": reason_ref,
        })
        if disposition == "include":
            included.append(instruction_ref)

    selected_refs = [str(ref["id"]) for ref in normalized_refs]
    if included != selected_refs:
        raise RuntimeError(
            "profile instruction_selection included candidates must exactly match ordered instruction_refs"
        )

    basis = {
        "kind": PROFILE_INSTRUCTION_SELECTION_KIND,
        "revision": revision,
        "source_set_ref": source_set_ref,
        "max_total_bytes": max_total_bytes,
        "candidates": candidates,
    }
    selection_hash = nonempty_text(
        raw.get("selection_hash"), "profile instruction_selection selection_hash"
    )
    expected_hash = sha256_text(canonical_json(basis))
    if selection_hash != expected_hash:
        raise RuntimeError("profile instruction_selection selection_hash mismatch")
    optional_delivery = {}
    if resolve_mode is not None:
        optional_delivery["resolve_mode"] = resolve_mode
    for field in ("mount_scope", "on_demand_corpus_set_ref"):
        if raw.get(field) is not None:
            optional_delivery[field] = nonempty_text(
                raw.get(field), f"profile instruction_selection {field}"
            )
    return {**basis, "selection_hash": selection_hash, **optional_delivery}


def compact_instruction_selection_receipt(selection: dict[str, Any]) -> dict[str, Any]:
    """Persist proof and counts, while leaving the full candidate DATA at its owner.

    The validated selection hash commits to every ordered candidate and reason.
    Copying that full list into every execution request made a large by-set-live
    receipt exceed the workflow transform boundary without adding new evidence.
    """
    candidates = selection.get("candidates", [])
    return {
        key: value for key, value in selection.items() if key != "candidates"
    } | {
        "candidate_count": len(candidates),
        "included_count": sum(1 for candidate in candidates if candidate.get("disposition") == "include"),
        "excluded_count": sum(1 for candidate in candidates if candidate.get("disposition") == "exclude"),
    }


def select_profile_instruction_refs(
    agent_id: str | None,
    profile_rows: list[dict[str, Any]],
) -> tuple[
    dict[str, Any],
    dict[str, Any],
    list[dict[str, str | None]],
    dict[str, Any] | None,
] | None:
    """Resolve one profile and its bounded ordered instruction references.

    The workflow uses this same function before owner hydration so it can query
    only the selected references. The final prompt builder calls it again before
    accepting the hydrated rows. One resolver therefore owns profile ambiguity,
    reference normalization, selection-lineage validation, and hard limits.
    """
    if not agent_id:
        return None

    profile_matches: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for raw in profile_rows:
        payload = profile_payload(raw)
        if payload is not None and as_string(payload.get("id")) == agent_id:
            profile_matches.append((raw, payload))
    if not profile_matches:
        # An agent_ref may name a CLI directly. A CLI has no profile-owned
        # instructions and must not trigger a whole-corpus fallback query.
        return None
    if len(profile_matches) != 1:
        raise RuntimeError(f"selected profile must resolve exactly one current row: {agent_id}")

    profile_row, selected_profile = profile_matches[0]
    raw_refs = selected_profile.get("instruction_refs", [])
    if not isinstance(raw_refs, list):
        raise RuntimeError(f"selected profile instruction_refs must be an ordered list: {agent_id}")
    if len(raw_refs) > MAX_PROFILE_INSTRUCTION_ITEMS:
        raise RuntimeError("selected profile instruction count exceeds hard limit")
    refs = [normalized_instruction_ref(raw) for raw in raw_refs]
    instruction_selection = validate_profile_instruction_selection(selected_profile, refs)
    return profile_row, selected_profile, refs, instruction_selection


def hydrate_profile_instructions(
    agent_id: str | None,
    profile_rows: list[dict[str, Any]],
    instruction_rows: list[dict[str, Any]],
    materialization: dict[str, Any] | None = None,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Resolve one selected profile's ordered instruction refs through owner rows.

    This is pure prompt assembly: no I/O, provider selection, product vocabulary,
    or instruction IDs live here. Missing, ambiguous, duplicate, inactive, stale,
    malformed, and oversized references fail closed before provider dispatch.
    """
    empty = {
        "kind": PROFILE_INSTRUCTION_SNAPSHOT_KIND,
        "profile_id": agent_id,
        "profile_revision": None,
        "profile_content_hash": None,
        "items": [],
        "item_count": 0,
        "content_bytes": 0,
        "limits": {
            "max_items": MAX_PROFILE_INSTRUCTION_ITEMS,
            "max_item_bytes": MAX_PROFILE_INSTRUCTION_ITEM_BYTES,
            "max_total_bytes": MAX_PROFILE_INSTRUCTION_TOTAL_BYTES,
        },
        "snapshot_hash": sha256_text("[]"),
    }
    if not agent_id:
        return empty

    selection = select_profile_instruction_refs(agent_id, profile_rows)
    if selection is None:
        return empty
    profile_row, selected_profile, refs, instruction_selection = selection

    profile_normalized = canonical_json(selected_profile)
    profile_hash = sha256_text(profile_normalized)
    profile_revision = (
        profile_row.get("current_revision", profile_row.get("revision"))
        if isinstance(profile_row, dict) else None
    )
    profile_revision = (
        as_string(profile_revision)
        or as_string(selected_profile.get("revision_ref"))
        or as_string(selected_profile.get("revision"))
        or profile_hash
    )
    empty.update({
        "profile_revision": profile_revision,
        "profile_content_hash": profile_hash,
        **({"instruction_selection": instruction_selection} if instruction_selection else {}),
    })
    if instruction_selection and instruction_selection.get("resolve_mode") == "by-set-live":
        if instruction_rows:
            raise RuntimeError(
                "by-set-live profile instructions must arrive only through CAS materialization"
            )
        if not isinstance(materialization, dict):
            raise RuntimeError("by-set-live profile instruction materialization is required")
        source_set_ref = instruction_selection["source_set_ref"]
        if not source_set_ref.startswith("harness-set:") or source_set_ref == "harness-set:":
            raise RuntimeError("by-set-live profile source_set_ref must name a harness-set")
        content_hash = nonempty_text(
            materialization.get("content_hash"), "profile instruction materialization content_hash"
        )
        if ":" not in content_hash:
            raise RuntimeError("profile instruction materialization content_hash is malformed")
        address = nonempty_text(
            materialization.get("address"), "profile instruction materialization address"
        )
        expected_address = (
            f"package::ai-instruction-blocks::harness-prompt::{request_id}"
            if request_id else None
        )
        if expected_address is not None and address != expected_address:
            raise RuntimeError("profile instruction materialization address does not match request_id")
        content_bytes = materialization.get("content_bytes", materialization.get("bytes"))
        if (
            not isinstance(content_bytes, int)
            or isinstance(content_bytes, bool)
            or content_bytes <= 0
            or content_bytes > instruction_selection["max_total_bytes"]
        ):
            raise RuntimeError("profile instruction materialization bytes exceed selection limit")
        block_count = materialization.get("block_count")
        if not isinstance(block_count, int) or isinstance(block_count, bool) or block_count <= 0:
            raise RuntimeError("profile instruction materialization block_count must be positive")
        missing = materialization.get("missing")
        if missing != []:
            raise RuntimeError("profile instruction materialization must have no missing blocks")
        materialization_receipt = {
            "address": address,
            "content_hash": content_hash,
            "bytes": content_bytes,
            "block_count": block_count,
            "missing": [],
        }
        snapshot_basis = {
            "profile_id": agent_id,
            "profile_revision": profile_revision,
            "profile_content_hash": profile_hash,
            "instruction_selection": instruction_selection,
            "delivery_mode": "cas-system-prompt",
            "materialization": materialization_receipt,
        }
        compact_selection = compact_instruction_selection_receipt(instruction_selection)
        return {
            **empty,
            "instruction_selection": compact_selection,
            "delivery_mode": "cas-system-prompt",
            "materialization": materialization_receipt,
            "content_bytes": content_bytes,
            "limits": {
                "max_items": MAX_PROFILE_INSTRUCTION_ITEMS,
                "max_item_bytes": MAX_PROFILE_INSTRUCTION_ITEM_BYTES,
                "max_total_bytes": instruction_selection["max_total_bytes"],
            },
            "snapshot_hash": sha256_text(canonical_json(snapshot_basis)),
        }
    if materialization is not None:
        raise RuntimeError("profile instruction materialization was supplied for a direct profile")
    if not refs:
        empty["snapshot_hash"] = sha256_text(canonical_json({
            "profile_id": agent_id,
            "profile_revision": profile_revision,
            "items": [],
        }))
        return empty

    by_id: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for raw in instruction_rows:
        payload = instruction_payload(raw)
        instruction_id = as_string(payload.get("id")) if payload is not None else None
        if instruction_id:
            by_id.setdefault(instruction_id, []).append((raw, payload))

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    total_bytes = 0
    for position, ref in enumerate(refs):
        instruction_id = ref["id"]
        if instruction_id in seen:
            raise RuntimeError("selected profile instruction_refs must not contain duplicates")
        seen.add(instruction_id)
        matches = by_id.get(instruction_id, [])
        if len(matches) != 1:
            raise RuntimeError(
                f"profile instruction must resolve exactly one current owner row: {instruction_id}"
            )
        row, payload = matches[0]
        status = as_string(payload.get("status"))
        if status is not None and status not in {"active", "available", "enabled"}:
            raise RuntimeError(f"profile instruction is not active: {instruction_id}")
        body = payload.get("body")
        if not isinstance(body, str) or not body.strip() or "\x00" in body:
            raise RuntimeError(f"profile instruction body is missing or malformed: {instruction_id}")
        body_bytes = len(body.encode("utf-8"))
        if body_bytes > MAX_PROFILE_INSTRUCTION_ITEM_BYTES:
            raise RuntimeError(f"profile instruction exceeds per-item byte limit: {instruction_id}")
        selected_total_limit = (
            instruction_selection["max_total_bytes"]
            if instruction_selection is not None
            else MAX_PROFILE_INSTRUCTION_TOTAL_BYTES
        )
        if total_bytes + body_bytes > selected_total_limit:
            raise RuntimeError("selected profile instructions exceed total byte limit")
        total_bytes += body_bytes

        body_hash = sha256_text(body)
        owner_content_hash = (
            as_string(row.get("content_hash"))
            or as_string(row.get("payload_hash"))
            or as_string(payload.get("content_hash"))
            or as_string(payload.get("source_hash"))
            or body_hash
        )
        revision = (
            as_string(row.get("current_revision"))
            or as_string(row.get("revision"))
            or as_string(payload.get("revision_ref"))
            or as_string(payload.get("revision"))
            or owner_content_hash
        )
        if ref["expected_revision"] is not None and ref["expected_revision"] != revision:
            raise RuntimeError(f"profile instruction is stale at {instruction_id}: revision mismatch")
        if (
            ref["expected_content_hash"] is not None
            and ref["expected_content_hash"] not in {owner_content_hash, body_hash}
        ):
            raise RuntimeError(f"profile instruction is stale at {instruction_id}: content hash mismatch")
        items.append({
            "position": position,
            "id": instruction_id,
            "revision": revision,
            "owner_content_hash": owner_content_hash,
            "body_hash": body_hash,
            "body_bytes": body_bytes,
            "body": body,
        })

    snapshot_basis = {
        "profile_id": agent_id,
        "profile_revision": profile_revision,
        "profile_content_hash": profile_hash,
        "items": [
            {key: value for key, value in item.items() if key != "body"}
            for item in items
        ],
    }
    return {
        **empty,
        "items": items,
        "item_count": len(items),
        "content_bytes": total_bytes,
        "snapshot_hash": sha256_text(canonical_json(snapshot_basis)),
    }


def profile_instruction_prompt(snapshot: dict[str, Any]) -> str:
    if not snapshot["items"]:
        return ""
    sections = ["Selected agent instructions (ordered current-owner snapshot):"]
    for item in snapshot["items"]:
        sections.append(f"\n[Instruction {item['position'] + 1}: {item['id']}]\n{item['body']}")
    return "\n".join(sections) + "\n\nUser request:\n"


def profile_instruction_receipt(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Body-free evidence safe to persist on result and execution-history rows."""
    return {
        key: value
        for key, value in snapshot.items()
        if key != "items"
    } | {
        "items": [
            {key: value for key, value in item.items() if key != "body"}
            for item in snapshot["items"]
        ]
    }


def fact_payload(row: Any) -> dict[str, Any]:
    """Accept BOTH row shapes: a flat attribute_fact row ({subject_id,property_id,value_json}),
    and a published-record row ({record:{address}, payload:{table:'attribute_fact', subject_id,
    property_id, value_json}}). Steps 0/1/2 query in:'published-record' + {table eq attribute_fact}
    (not the fold-only in:'attribute_fact' projection) so LIVE-written config resolves without a
    re-fold — so the rows now arrive wrapped in `payload`. Flat rows pass through unchanged."""
    if isinstance(row, dict) and isinstance(row.get("payload"), dict):
        return row["payload"]
    return row if isinstance(row, dict) else {}


def group_rows(rows: list[dict[str, Any]], id_key: str) -> list[dict[str, Any]]:
    """Fold flat attribute_fact rows into per-subject dicts keyed by property_id."""
    grouped: dict[str, dict[str, Any]] = {}
    for raw in rows:
        row = fact_payload(raw)
        subject_id = as_string(row.get("subject_id"))
        property_id = as_string(row.get("property_id"))
        if subject_id is None or property_id is None:
            continue
        current = grouped.setdefault(subject_id, {id_key: subject_id, "subject_id": subject_id})
        # find-current-items returns value_json as a raw JSON string; decode it so
        # downstream checks (isinstance dict/list/bool) see real values. Already-decoded
        # values (or non-JSON text) pass through unchanged.
        value = row.get("value_json")
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except (ValueError, TypeError):
                pass
        current[property_id] = value
    return list(grouped.values())


def first_default_model(models: Any) -> str | None:
    if not isinstance(models, list):
        return None
    for model in models:
        if (
            isinstance(model, dict)
            and (model.get("isDefault") is True or model.get("is_default") is True)
            and as_string(model.get("id"))
        ):
            return model["id"]
    for model in models:
        if isinstance(model, dict) and as_string(model.get("id")):
            return model["id"]
    return None


def cli_identity_matches(cli: dict[str, Any], requested_cli_id: str) -> bool:
    # A picker selects a participant by its cli name (the `prop:cli_registry:cli`
    # value, e.g. "ollama"), so agent_ref arrives as the bare name. The cli is
    # always present via its self-identifying subject_id ("cli:ollama") — every cli
    # row carries one (chat_launch alone is enough to surface it). Match the bare
    # name against that subject_id form too, so routing never depends on a separate
    # `prop:cli_registry:cli` attribute_fact also being projected into
    # find-current-items (it may be a fold-only / live-discovery row). Without this,
    # a named local participant silently falls through to provider-primary and the
    # wrong CLI runs the foreign model id.
    subject_id = cli.get("subject_id")
    if subject_id == requested_cli_id or cli.get("prop:cli_registry:cli") == requested_cli_id:
        return True
    if isinstance(subject_id, str):
        if subject_id == f"cli:{requested_cli_id}":
            return True
        if ":" in subject_id and subject_id.rsplit(":", 1)[-1] == requested_cli_id:
            return True
    return False


def cli_supports_model(cli: dict[str, Any], model_id: str | None) -> bool:
    if not model_id:
        return False
    models = cli.get("prop:cli_registry:models")
    if not isinstance(models, list):
        return False
    for model in models:
        if not isinstance(model, dict):
            continue
        candidate = as_string(model.get("id")) or as_string(model.get("model"))
        if candidate == model_id:
            return True
    return False


def resolve_cli_by_model(clis: list[dict[str, Any]], model_id: str | None) -> dict[str, Any] | None:
    if not model_id:
        return None
    for cli in clis:
        if cli_supports_model(cli, model_id):
            return cli
    return None


def provider_keys(provider: dict[str, Any]) -> set[str]:
    keys = {provider["provider_id"]}
    vendor = as_string(provider.get("prop:provider:vendor"))
    if vendor:
        keys.add(vendor)
        keys.add(f"provider:{vendor}")
    return keys


def _compare_policy_values(left: Any, right: Any, missing: str | None) -> int:
    left_missing = left is None
    right_missing = right is None
    if left_missing or right_missing:
        if left_missing and right_missing:
            return 0
        missing_order = -1 if missing == "first" else 1
        return missing_order if left_missing else -missing_order
    if isinstance(left, (int, float)) and not isinstance(left, bool) and isinstance(right, (int, float)) and not isinstance(right, bool):
        return -1 if left < right else 1 if left > right else 0
    left_text = canonical_json(left)
    right_text = canonical_json(right)
    return -1 if left_text < right_text else 1 if left_text > right_text else 0


def _provider_matches_condition(provider: dict[str, Any], condition: Any) -> bool:
    if not isinstance(condition, dict) or not as_string(condition.get("property_id")):
        raise RuntimeError("automatic provider routing policy contains an invalid eligibility condition")
    value = provider.get(condition["property_id"])
    if "equals" in condition:
        return canonical_json(value) == canonical_json(condition["equals"])
    if isinstance(condition.get("in"), list):
        return any(canonical_json(candidate) == canonical_json(value) for candidate in condition["in"])
    if isinstance(condition.get("contains_all"), list):
        return isinstance(value, list) and all(candidate in value for candidate in condition["contains_all"])
    raise RuntimeError("automatic provider routing policy condition has no supported comparison")


def resolve_provider(providers: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Resolve an empty selection from one provider-agnostic DATA policy.

    The policy names every eligibility and ordering field. Generic code knows no
    provider, transport, locality, pricing plan, or machine path. The primary
    flag remains only as a compatibility fallback while old package sets converge.
    """
    policy_rows = [p for p in providers if isinstance(p.get("prop:provider_routing:policy"), dict)]
    if not policy_rows:
        for provider in providers:
            if provider.get("prop:provider:is_primary") is True:
                return provider
        return next((p for p in providers if as_string(p.get("prop:provider:vendor"))), None)
    if len(policy_rows) != 1:
        raise RuntimeError("automatic provider routing policy must resolve exactly one row")
    policy = policy_rows[0]["prop:provider_routing:policy"]
    if (policy.get("kind") != "ai-provider-routing-policy"
            or not isinstance(policy.get("eligibility"), list)
            or not isinstance(policy.get("order_by"), list)
            or not policy["order_by"]):
        raise RuntimeError("automatic provider routing policy is malformed")
    eligible = [
        provider for provider in providers
        if as_string(provider.get("prop:provider:vendor"))
        and all(_provider_matches_condition(provider, condition) for condition in policy["eligibility"])
    ]

    from functools import cmp_to_key

    def compare(left: dict[str, Any], right: dict[str, Any]) -> int:
        for order in policy["order_by"]:
            if (not isinstance(order, dict) or not as_string(order.get("property_id"))
                    or order.get("direction") not in ("asc", "desc")
                    or order.get("missing") not in (None, "first", "last")):
                raise RuntimeError("automatic provider routing policy contains an invalid ordering rule")
            compared = _compare_policy_values(
                left.get(order["property_id"]), right.get(order["property_id"]), order.get("missing")
            )
            if compared:
                return -compared if order["direction"] == "desc" else compared
        left_id = str(left.get("subject_id", ""))
        right_id = str(right.get("subject_id", ""))
        return -1 if left_id < right_id else 1 if left_id > right_id else 0

    eligible.sort(key=cmp_to_key(compare))
    if not eligible:
        raise RuntimeError("No verified provider satisfies automatic routing policy")
    return eligible[0]


def resolve_requested_model(model_ref: str, rows: list[dict[str, Any]]) -> tuple[str, str | None]:
    if not model_ref:
        return "", None
    if not model_ref.startswith("ai-model-descriptor:"):
        return model_ref, None
    matches = []
    for row in rows:
        payload = row.get("payload") if isinstance(row, dict) and isinstance(row.get("payload"), dict) else row
        if isinstance(payload, dict) and payload.get("kind") == "ai-model-descriptor" and payload.get("id") == model_ref:
            matches.append(payload)
    if len(matches) != 1 or matches[0].get("status") != "available":
        raise RuntimeError("requested model descriptor must resolve exactly one available row")
    model_id = as_string(matches[0].get("model_id"))
    provider_ref = as_string(matches[0].get("provider_ref"))
    if not model_id or not provider_ref:
        raise RuntimeError("requested model descriptor is incomplete")
    return model_id, provider_ref


def resolve_provider_by_ref(providers: list[dict[str, Any]], provider_ref: str | None) -> dict[str, Any] | None:
    if not provider_ref:
        return None
    bare = re.sub(r"^(?:ai_)?provider:", "", provider_ref)
    matches = []
    for provider in providers:
        keys = provider_keys(provider)
        if provider_ref in keys or bare in keys or f"provider:{bare}" in keys:
            matches.append(provider)
    if len(matches) != 1:
        raise RuntimeError("requested model provider must resolve exactly one row")
    return matches[0]


def resolve_cli(
    provider: dict[str, Any] | None,
    clis: list[dict[str, Any]],
    requested_cli_id: str | None,
) -> dict[str, Any] | None:
    if requested_cli_id:
        for cli in clis:
            if cli_identity_matches(cli, requested_cli_id):
                return cli
    if provider is None:
        return clis[0] if clis else None
    keys = provider_keys(provider)
    for cli in clis:
        provider_ids = cli.get("prop:cli_registry:provider_ids")
        if isinstance(provider_ids, list) and any(isinstance(item, str) and item in keys for item in provider_ids):
            return cli
    return clis[0] if clis else None


def resolve_cli_for_provider(
    provider: dict[str, Any] | None,
    clis: list[dict[str, Any]],
    model_id: str | None,
) -> dict[str, Any] | None:
    if provider is None:
        return None
    keys = provider_keys(provider)
    matches = []
    for cli in clis:
        provider_ids = cli.get("prop:cli_registry:provider_ids")
        launch = cli.get("prop:cli_registry:chat_launch")
        transport = (as_string(launch.get("transport")) or "process") if isinstance(launch, dict) else None
        if (
            transport in ("http", "process")
            and isinstance(provider_ids, list)
            and any(isinstance(item, str) and item in keys for item in provider_ids)
        ):
            matches.append(cli)
    model_matches = [cli for cli in matches if cli_supports_model(cli, model_id)] if model_id else []
    eligible = model_matches if model_id else matches
    if len(eligible) > 1:
        raise RuntimeError("requested model provider has ambiguous CLI transports")
    return eligible[0] if eligible else None


def read_path(source: Any, path: list[str]) -> Any:
    current = source
    for part in path:
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def should_use_argument(argument: dict[str, Any], context: dict[str, Any]) -> bool:
    """`when` is an OPEN context-key condition (L090): `new`/`resume` are the two
    structural resume-ness states; ANY other value gates on the truthiness of that
    context key — so a launch descriptor can declare `when:"temperature"` (or any
    parameter a caller sends) and it works with zero code here."""
    condition = argument.get("when")
    if condition is None:
        return True
    if condition == "new":
        return not context.get("resume", False)
    if condition == "resume":
        return context.get("resume", False)
    return bool(context.get(condition))


def render_argument(argument: Any, context: dict[str, Any]) -> str | None:
    if isinstance(argument, str):
        return argument
    if not isinstance(argument, dict) or not should_use_argument(argument, context):
        return None
    literal = as_string(argument.get("literal"))
    if literal is not None:
        return literal
    value_key = as_string(argument.get("value"))
    value = context.get(value_key) if value_key else None
    if isinstance(value, str) and value:
        return value
    # Value absent. An EXPLICITLY optional arg drops (None → removed from argv, e.g. a
    # bare `--flag` with no value). A POSITIONAL arg (the default) must keep its slot as
    # an EMPTY STRING — dropping it shifts every later positional, which is exactly how a
    # launch like `python3 -c "...sys.argv[4]..."` IndexErrored when `model` was absent
    # (the missing model slot shifted `prompt` out of range). Empty placeholder preserves
    # positions; the launch script itself decides its default (e.g. `m or 'gemma3n:e4b'`).
    return None if argument.get("optional") is True else ""


def render_env(launch: dict[str, Any], account: dict[str, Any] | None) -> dict[str, str]:
    env: dict[str, str] = {}
    for binding in launch.get("env") or []:
        if not isinstance(binding, dict):
            continue
        name = as_string(binding.get("name"))
        source = binding.get("source")
        if name is None or not isinstance(source, dict) or source.get("from") != "account":
            continue
        path = source.get("path")
        if not isinstance(path, list) or not all(isinstance(part, str) for part in path):
            continue
        value = read_path(account or {}, path)
        if isinstance(value, str) and value:
            env[name] = value
    return env


def render_argv_and_cwd(launch: dict[str, Any], context: dict[str, Any]) -> tuple[list[str], str]:
    """
    Shared by every process-shaped transport (one-shot compute.process AND live
    compute.process_session): render the DATA argv descriptor + resolve cwd. Kept
    as ONE function so a future third process-shaped transport never re-derives
    this rendering logic (L043 — no whack-a-mole across transport builders).
    """
    argv_source = launch.get("argv")
    if not isinstance(argv_source, list):
        raise RuntimeError("Selected CLI has no chat launch argv descriptor")
    argv = [rendered for item in argv_source if (rendered := render_argument(item, context)) is not None]
    if not argv:
        raise RuntimeError("Selected CLI launch descriptor rendered an empty argv")
    launch_cwd = launch.get("cwd")
    if launch_cwd == "projectPath":
        cwd = context.get("projectPath")
    elif isinstance(launch_cwd, str) and launch_cwd:
        cwd = launch_cwd
    else:
        cwd = "."
    return argv, (cwd if isinstance(cwd, str) and cwd else ".")


def build_process_descriptor(launch: dict[str, Any], context: dict[str, Any], account: dict[str, Any] | None) -> dict[str, Any]:
    retired_fields = {
        "sandbox_profile",
        "capture_stdout",
        "capture_stderr",
    }.intersection(launch)
    if retired_fields:
        raise RuntimeError(
            "Selected CLI uses retired process fields: " + ", ".join(sorted(retired_fields))
        )
    argv, cwd = render_argv_and_cwd(launch, context)
    executable = pathlib.PurePosixPath(argv[0])
    if executable.is_absolute() or "\\" in argv[0] or ".." in executable.parts:
        raise RuntimeError(
            "Selected CLI argv[0] must be a portable runtime alias or executable input mount"
        )
    if (
        pathlib.PurePath(cwd).is_absolute()
        or "\\" in cwd
        or ".." in pathlib.PurePath(cwd).parts
    ):
        raise RuntimeError(
            "Selected CLI launch cwd must be portable process-root data; materialize project bytes through input_trees"
        )
    inputs = list(launch.get("inputs")) if isinstance(launch.get("inputs"), list) else []
    system_prompt_hash = as_string(context.get("system_prompt_content_hash"))
    system_prompt_path = as_string(context.get("system_prompt_path"))
    if system_prompt_hash is not None or system_prompt_path is not None:
        if system_prompt_hash is None or system_prompt_path is None:
            raise RuntimeError("materialized system prompt requires both content hash and mount path")
        mount_path = pathlib.PurePosixPath(system_prompt_path)
        if mount_path.is_absolute() or ".." in mount_path.parts or "\\" in system_prompt_path:
            raise RuntimeError("materialized system prompt mount path must be portable and relative")
        if any(
            isinstance(entry, dict) and entry.get("mount_path") == system_prompt_path
            for entry in inputs
        ):
            raise RuntimeError("materialized system prompt mount path collides with launch inputs")
        inputs.append({
            "mount_path": system_prompt_path,
            "content_type": "text/markdown",
            "source": {"kind": "blob_ref", "hash": system_prompt_hash},
        })
    input_trees = launch.get("input_trees") if isinstance(launch.get("input_trees"), list) else []
    if "/" in argv[0] and not input_trees:
        executable_mounts = {
            entry.get("mount_path")
            for entry in inputs
            if isinstance(entry, dict) and entry.get("executable") is True
        }
        if argv[0] not in executable_mounts:
            raise RuntimeError(
                "Relative CLI argv[0] must name an executable input mount"
            )
    timeout_ms = launch.get("timeout_ms")
    return {
        "argv": argv,
        "cwd": None if cwd == "." else cwd,
        "timeout_ms": timeout_ms if isinstance(timeout_ms, int) and timeout_ms > 0 else 300000,
        "termination_grace_ms": 1000,
        "expected_termination": None,
        "env": render_env(launch, account),
        # Mounts are DATA-driven (L090/Physics-vs-Society): a CLI's chat_launch
        # descriptor may declare `inputs`/`outputs` mount specs and the generic
        # builder passes them through verbatim — the script never names a mount.
        # This is how the operator captures codex's clean final message: the
        # cli:codex chat_launch declares `outputs:[{mount_path:"codex-output.json"}]`
        # (paired with `--output-last-message codex-output.json` in argv), so
        # step_7 (compute.process) captures that file as `output.codex_output`.
        # It is REQUIRED on Fly because step_7.output.captured_fds is a bytes-ref that
        # a whole-output stringify does NOT dereference (only declared output
        # MOUNTS deref) — the ai-records-producer parse_empty root (ORC-303).
        "inputs": inputs,
        "input_trees": input_trees,
        "outputs": launch.get("outputs") if isinstance(launch.get("outputs"), list) else [],
        "containment": {
            "kind": "descendant_effect_contained",
            "pipe_eof_timeout_ms": 1000,
            "publications": [],
        },
        "capture_fds": [1, 2],
        "collected_files": [],
    }


def build_process_session_descriptor(
    launch: dict[str, Any],
    context: dict[str, Any],
    account: dict[str, Any] | None,
) -> dict[str, Any]:
    """
    Exact ProcessSessionDescriptor: one canonical portable ProcessDescriptor plus
    session settings. Interactive execution does not get a second argv/cwd/env or
    sandbox vocabulary; it uses the same owner-admitted process intent as a one-shot
    invocation and preserves only the distinct live event/feed lifecycle.
    """
    if "session_sandbox_profile" in launch:
        raise RuntimeError("Selected CLI uses a retired session sandbox field")
    process = build_process_descriptor(launch, context, account)
    timeout_ms = launch.get("session_timeout_ms")
    process["timeout_ms"] = timeout_ms if isinstance(timeout_ms, int) and timeout_ms > 0 else 300000
    process["outputs"] = []
    text_grid = launch.get("session_text_grid")
    settings: dict[str, Any] = {"text_grid": None}
    if (
        isinstance(text_grid, dict)
        and isinstance(text_grid.get("columns"), int)
        and isinstance(text_grid.get("rows"), int)
    ):
        settings["text_grid"] = {"columns": text_grid["columns"], "rows": text_grid["rows"]}
    return {"process": process, "session_settings": settings}


# ---------------------------------------------------------------------------
# Transport selection (L090 self-describing DATA, generic handler).
#
# "Invoke a model" is ONE primitive; the only variable is the transport. The
# model's chat_launch descriptor self-describes it via `transport`:
#   - "process"         (default) -> compute.process (a local CLI, one-shot run)
#   - "http"                      -> slot::http-client (a cloud provider endpoint)
#   - "process_session"           -> compute.process_session (a local CLI, LIVE
#                                     streaming session — same CLI substrate as
#                                     "process", different execution mode: the
#                                     caller gets the SessionStarted event-feed
#                                     pointer back immediately and subscribes to
#                                     live tokens instead of waiting for exit)
# The cloud body is a DATA `body_template` with {prompt}/{api_model} placeholders
# and the reply is extracted by a DATA `response_path`, so adding a provider
# (OpenAI/Gemini/Anthropic/anything) is a DATA row with ZERO code branch here.
# No provider/model/HTTP-shape names appear in this file.
# ---------------------------------------------------------------------------

def substitute_placeholders(node: Any, subs: dict[str, Any]) -> Any:
    """Render canonical template.value/sequence nodes and legacy text tokens."""
    if isinstance(node, str):
        for key, value in subs.items():
            replacement = scalar_text(value)
            node = node.replace("{{" + key + "}}", replacement)
            node = node.replace("{" + key + "}", replacement)
        return node
    if isinstance(node, dict):
        kind = node.get("$kind")
        binding = node.get("binding")
        if kind == "template.value" and isinstance(binding, str):
            return subs.get(binding)
        if kind == "template.sequence" and isinstance(binding, str):
            value = subs.get(binding)
            return value if isinstance(value, list) else []
        return {k: substitute_placeholders(v, subs) for k, v in node.items()}
    if isinstance(node, list):
        rendered: list[Any] = []
        for value in node:
            if isinstance(value, dict) and value.get("$kind") == "template.sequence":
                sequence = substitute_placeholders(value, subs)
                if isinstance(sequence, list):
                    rendered.extend(sequence)
            else:
                rendered.append(substitute_placeholders(value, subs))
        return rendered
    return node


def template_references_binding(node: Any, binding: str) -> bool:
    """Return whether a DATA template explicitly consumes one binding."""
    if isinstance(node, str):
        return "{{" + binding + "}}" in node or "{" + binding + "}" in node
    if isinstance(node, dict):
        if node.get("$kind") == "template.value" and node.get("binding") == binding:
            return True
        return any(template_references_binding(value, binding) for value in node.values())
    if isinstance(node, list):
        return any(template_references_binding(value, binding) for value in node)
    return False


def build_http_descriptor(launch: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    url = as_string(launch.get("url"))
    if not url:
        raise RuntimeError("cloud (http) launch descriptor has no url")
    api_model = as_string(launch.get("api_model")) or as_string(context.get("model")) or ""
    # The launch template reads the WHOLE invocation context (one rule): every
    # scalar context entry — prompt, model, any open parameter — is a `{key}`
    # placeholder in the url and body_template. `api_model` stays the resolved
    # HTTP-facing model name; `prompt` is re-set explicitly so both are always
    # present even when empty.
    subs: dict[str, Any] = dict(context)
    subs["prompt"] = context.get("prompt") or ""
    subs["api_model"] = api_model
    subs["model_id"] = api_model
    url = substitute_placeholders(url, subs)
    headers = launch.get("headers")
    if not isinstance(headers, dict):
        headers = {"Content-Type": "application/json"}
    body_template = launch.get("body_template")
    if body_template is None:
        raise RuntimeError("cloud (http) launch descriptor has no body_template")
    if "system_prompt" in context and not template_references_binding(
        body_template, "system_prompt"
    ):
        raise RuntimeError(
            "http-body-template transport must consume the system_prompt binding"
        )
    body_obj = substitute_placeholders(body_template, subs)
    # http-client CallExternalRequest.body is Option<Vec<u8>> — a byte sequence.
    body_bytes = list(json.dumps(body_obj, ensure_ascii=False).encode("utf-8"))
    # The credential is pure DATA: the connected-service secret NAME + placement.
    # http-client mints the handle from the secret name at execution time (vault
    # read) — the producer never touches a live credential handle. No god package.
    credential = launch.get("credential")
    injections: list[dict[str, Any]] = []
    if isinstance(credential, dict) and isinstance(credential.get("placement"), dict):
        secret_name = as_string(credential.get("secret_name"))
        if secret_name:
            injections.append({"secret_name": secret_name, "placement": credential["placement"]})
    timeout_ms = launch.get("timeout_ms")
    return {
        "url": url,
        "method": as_string(launch.get("method")) or "POST",
        "headers": headers,
        "body": body_bytes,
        "credential_injections": injections,
        "timeout_ms": timeout_ms if isinstance(timeout_ms, int) else 120000,
    }


def build_transport(
    launch: dict[str, Any],
    context: dict[str, Any],
    account: dict[str, Any] | None,
) -> dict[str, Any]:
    """Return the DATA-selected slot, payload, and opaque reply extractor."""
    transport_kind = as_string(launch.get("transport")) or "process"
    caller_context = launch.get("context")
    if not isinstance(caller_context, dict):
        caller_context = None
    if transport_kind == "http":
        response_extract = launch.get("response_extract")
        transport = {
            "slot": as_string(launch.get("target_slot")) or "slot::http-client",
            "payload": build_http_descriptor(launch, context),
            "response_path": as_string(launch.get("response_path")) or "",
            "response_extract": response_extract if isinstance(response_extract, dict) else None,
        }
        if caller_context is not None:
            transport["context"] = caller_context
        return transport
    if transport_kind == "process_session":
        # LIVE STREAMING transport: same CLI substrate as "process", different
        # execution mode. ProcessSessionRequest is `#[serde(tag="operation",
        # rename_all="snake_case")]` (architect/crates/execution-types/src/
        # process_session_types.rs) — StartSession{descriptor} serializes as
        # {"operation":"start_session","descriptor":{...}}. compute.process_session
        # deserializes the raw envelope payload directly (same generic
        # deserialize_payload helper as compute.process — no extra wrapping).
        transport = {
            "slot": "compute.process_session",
            "payload": {
                "operation": "start_session",
                "descriptor": build_process_session_descriptor(launch, context, account),
            },
            "response_path": "",
        }
        if caller_context is not None:
            transport["context"] = caller_context
        return transport
    transport = {
        "slot": "compute.process",
        "payload": build_process_descriptor(launch, context, account),
        "response_path": "",
    }
    if caller_context is not None:
        transport["context"] = caller_context
    return transport


# ---------------------------------------------------------------------------
# selected-agent + ai-agent-profile resolution (new, not in the precedent)
# ---------------------------------------------------------------------------

def resolve_agent_id(selected_agent_rows: list[dict[str, Any]]) -> str | None:
    """
    Extracts the selected agent id from attribute_fact rows for
    subject_id='selected-agent:current', property_id='prop:selected_agent:id'.

    step.output.items[0].value_json is the JSON-encoded id string.
    """
    for raw_row in selected_agent_rows:
        row = fact_payload(raw_row)
        subject = as_string(row.get("subject_id"))
        prop = as_string(row.get("property_id"))
        if subject == "selected-agent:current" and prop == "prop:selected_agent:id":
            raw = row.get("value_json")
            # value_json may be a quoted JSON string, e.g. '"ai-agent-profile:writer"'
            if isinstance(raw, str):
                try:
                    decoded = json.loads(raw)
                    if isinstance(decoded, str) and decoded.strip():
                        return decoded.strip()
                except Exception:
                    pass
                if raw.strip():
                    return raw.strip()
    return None


def resolve_profile_launch(
    agent_id: str,
    profile_rows: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """
    Find the ai-agent-profile record matching agent_id and return its
    process_launch descriptor (or None if not present/found).

    Profile rows are `find-current-items in:'published-record'` rows: the record
    fields (kind/id/process_launch/...) are at the TOP LEVEL of the row (FLAT),
    not nested under a `payload` key. (Verified live against slot::find-current-items:
    rows expose kind/id/model_refs/instruction_refs/... directly.) A legacy nested
    `{payload:{...}}` row is still tolerated. Field names per resolve-agent-cards.ts:162-183.
    """
    for row in profile_rows:
        if not isinstance(row, dict):
            continue
        # FLAT published-record row → the row IS the record; legacy nested → unwrap payload.
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else row
        if not isinstance(payload, dict):
            continue
        if payload.get("kind") != "ai-agent-profile":
            continue
        if as_string(payload.get("id")) != agent_id:
            continue
        # process_launch / processLaunch / launch — mirrors resolve-agent-cards.ts:179
        launch = (
            payload.get("process_launch")
            or payload.get("processLaunch")
            or payload.get("launch")
        )
        if isinstance(launch, dict):
            return launch
    return None


def resolve_profile_output_kind(
    agent_id: str,
    profile_rows: list[dict[str, Any]],
) -> str | None:
    """
    Return the ai-agent-profile.produce_output_kind for agent_id (the agent's own
    record kind, DATA on its profile), or None if not present. This makes output_kind
    L090 DATA-driven: a caller that forwards agent_ref but omits output_kind (e.g. the
    decoupled produce-from-request drainer, whose trigger template carries no
    output_kind) still gets the RIGHT kind per agent, with zero per-agent code.
    Same flat/nested published-record row handling as resolve_profile_launch.
    """
    for row in profile_rows:
        if not isinstance(row, dict):
            continue
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else row
        if not isinstance(payload, dict):
            continue
        if payload.get("kind") != "ai-agent-profile":
            continue
        if as_string(payload.get("id")) != agent_id:
            continue
        return as_string(payload.get("produce_output_kind")) or None
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build a compute.process descriptor for an ai-records-producer run."
    )
    # New: selected-agent and profile rows (the canonical SSOT)
    parser.add_argument("--selected-agent-rows-json", required=True,
                        help="JSON array of attribute_fact rows for selected-agent:current")
    parser.add_argument("--profile-rows-json", required=True,
                        help="JSON array of published-record rows for ai-agent-profile")
    parser.add_argument("--model-descriptor-rows-json", default="[]",
                        help="Exact published ai-model-descriptor row for a descriptor-ref model selection")
    # Fallback: provider + CLI registry rows (cloned from prompt-to-variations)
    parser.add_argument("--provider-rows-json", required=True,
                        help="JSON array of attribute_fact rows for provider facts")
    parser.add_argument("--cli-rows-json", required=True,
                        help="JSON array of attribute_fact rows for cli-registry facts")
    # Superset-safe compatibility reads for selected-agent/provider config that
    # may still be current-item projections. CLI rows now come from canonical
    # prop:cli_registry:* fold paths through find-current-items path_labels; the
    # published-record CLI argument remains an optional legacy fallback.
    parser.add_argument("--selected-agent-pub-rows-json", default="[]",
                        help="published-record rows for selected-agent:current (live-written config)")
    parser.add_argument("--provider-pub-rows-json", default="[]",
                        help="published-record rows for provider facts (live-written config)")
    parser.add_argument("--cli-pub-rows-json", default="[]",
                        help="published-record rows for cli-registry facts (live-written config)")
    parser.add_argument("--instruction-rows-json", default="[]",
                        help="Current ai-records-producer.instruction and ai-instruction-block owner "
                             "rows. Producer instructions preserve wrap_instruction_ref compatibility; "
                             "instruction blocks hydrate a direct profile's ordered instruction_refs. "
                             "A by-set-live profile uses --harness-materialization-json instead.")
    parser.add_argument("--harness-materialization-json", default="null",
                        help="Optional small hash-only result from "
                             "ai-instruction-blocks.materialize-harness-prompt. Required only for "
                             "a by-set-live profile; the prompt bytes remain in CAS.")
    parser.add_argument("--harness-materialization-address", default="")
    parser.add_argument("--harness-materialization-content-hash", default="")
    parser.add_argument("--harness-materialization-bytes", default="")
    parser.add_argument("--harness-materialization-block-count", default="")
    parser.add_argument("--harness-materialization-missing-json", default="")
    parser.add_argument("--harness-system-prompt-file", default="",
                        help="Optional CAS-mounted prompt bytes for an http-body-template launch. "
                             "The file path is fixed workflow DATA, never caller-supplied argv content.")
    parser.add_argument("--producer-instruction-rows-json", default="[]",
                        help="Projection-bounded ai-records-producer.instruction rows used only to "
                             "resolve the optional legacy wrap_instruction_ref.")
    parser.add_argument("--addressed-input-rows-json", default="[]",
                        help="Current-owner rows selected by input_refs before provider dispatch. "
                             "When input_refs are present, each address must resolve exactly once and "
                             "is snapshotted with its revision, content hash, bounded normalized content, "
                             "and provenance. This script performs no owner I/O.")
    # ALL caller-supplied request fields arrive as ONE machine-readable --input-json
    # object (the same flat input the dispatcher/board/triggers send). This kills the
    # entire absent-optional-arg → null-positional-argv → FE_CODEC_ERROR class (L063):
    # an OMITTED optional key (model / agent_ref / wrap_instruction_ref) just .get()s to
    # "" here, so a dispatcher (e.g. a reactive trigger) never has to remember to send
    # empty strings. Required by-step/by-context args stay as their own flags.
    parser.add_argument("--input-json", required=True,
                        help="JSON object of the caller's request: instruction_text, output_kind, "
                             "model, agent_ref, wrap_instruction_ref, request_id. Optional keys may "
                             "be absent; each defaults to '' here (no positional null can occur).")
    parser.add_argument("--partition-key", required=True)
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()

    # One object → all request fields. Absent optional keys resolve to "" (never null).
    try:
        input_obj = json.loads(args.input_json) if args.input_json else {}
    except Exception:
        input_obj = {}
    if not isinstance(input_obj, dict):
        input_obj = {}
    instruction_rows = parse_rows(args.instruction_rows_json)
    harness_materialization = parse_optional_object(
        args.harness_materialization_json, "harness materialization"
    )
    scalar_materialization = {
        "address": args.harness_materialization_address,
        "content_hash": args.harness_materialization_content_hash,
        "bytes": args.harness_materialization_bytes,
        "block_count": args.harness_materialization_block_count,
        "missing": args.harness_materialization_missing_json,
    }
    if any(value != "" for value in scalar_materialization.values()):
        if harness_materialization is not None:
            raise RuntimeError("harness materialization must use either JSON or scalar fields, not both")
        if any(value == "" for value in scalar_materialization.values()):
            raise RuntimeError("harness materialization scalar fields must be supplied together")
        try:
            scalar_missing = json.loads(scalar_materialization["missing"])
            scalar_bytes = int(scalar_materialization["bytes"])
            scalar_block_count = int(scalar_materialization["block_count"])
        except Exception as error:
            raise RuntimeError("harness materialization scalar fields are malformed") from error
        harness_materialization = {
            "address": scalar_materialization["address"],
            "content_hash": scalar_materialization["content_hash"],
            "bytes": scalar_bytes,
            "block_count": scalar_block_count,
            "missing": scalar_missing,
        }
        # The materialize-harness-prompt direct-profile mode writes an inert
        # sentinel prompt (currently <!-- no profile instructions -->, 33 bytes)
        # and returns its CAS hash. block_count=0 + non-negative bytes +
        # missing=[] identifies that sentinel; the workflow always forwards the
        # receipt, but a direct profile's instruction_rows are the real payload.
        # Treating the sentinel as absent keeps the workflow's always-forward
        # shape while preserving the positive-block-count by-set guard below.
        if (
            scalar_bytes >= 0
            and scalar_block_count == 0
            and scalar_missing == []
        ):
            harness_materialization = None
    producer_instruction_rows = parse_rows(args.producer_instruction_rows_json)
    instruction_text = as_string(input_obj.get("instruction_text")) or ""
    # output_kind is resolved AFTER agent_id (below): caller input wins; else the
    # agent's profile produce_output_kind (L090 DATA-driven); else "note".
    output_kind = as_string(input_obj.get("output_kind"))
    model_ref = as_string(input_obj.get("model")) or ""
    cli_override = as_string(input_obj.get("agent_ref")) or ""
    wrap_instruction_ref = as_string(input_obj.get("wrap_instruction_ref")) or ""
    # Resolve wrap_instruction_ref -> the instruction record's wrap_prefix (L090 DATA-driven).
    # The workflow reads EVERY ai-records-producer.instruction through its own exact-kind,
    # projection-bounded query and passes them via --producer-instruction-rows-json; select the
    # row whose id == the ref's last '::' segment. Without
    # this the CLI prompt was instruction_text BARE (empty for callers like produce_icebreakers that
    # pass only wrap_instruction_ref) -> the model got no instructions -> agentic/garbage output.
    # Absent/unmatched -> wrap_prefix "" -> prompt stays instruction_text (backward-compatible).
    wrap_prefix = ""
    if wrap_instruction_ref:
        _target_instruction_id = wrap_instruction_ref.split("::")[-1]
        wrap_instruction_rows = producer_instruction_rows or instruction_rows
        for _instruction_row in wrap_instruction_rows:
            _ip = (_instruction_row.get("payload")
                   if isinstance(_instruction_row, dict) and isinstance(_instruction_row.get("payload"), dict)
                   else _instruction_row)
            if isinstance(_ip, dict) and as_string(_ip.get("id")) == _target_instruction_id:
                wrap_prefix = as_string(_ip.get("wrap_prefix")) or ""
                break
    request_id = as_string(input_obj.get("request_id")) or ""
    # Open per-invocation parameter bag (L090): keys are launch-template DATA
    # (a `when:"<key>"`/`{value:"<key>"}` argv condition, an `{<key>}` http
    # placeholder) — this script never enumerates them.
    raw_parameters = input_obj.get("parameters")
    parameters = raw_parameters if isinstance(raw_parameters, dict) else {}
    # Resolve every addressed input before choosing/dispatching the provider. The
    # workflow supplies the current-owner query result; this pure builder turns it
    # into one immutable evidence snapshot and makes the exact snapshot part of
    # the prompt. No later stage needs to re-read mutable caller data.
    addressed_input_snapshot = hydrate_addressed_inputs(
        input_obj, parse_rows(args.addressed_input_rows_json)
    )

    # Parse rows. DUAL-READ: concat folded (attribute_fact projection) + live-written
    # (published-record) sources so config resolves on every app (fact_payload() below
    # normalizes both row shapes). Order is irrelevant — resolve_* dedup/first-match.
    selected_agent_rows = parse_rows(args.selected_agent_rows_json) + parse_rows(args.selected_agent_pub_rows_json)
    profile_rows = parse_rows(args.profile_rows_json)
    model_override, requested_provider_ref = resolve_requested_model(
        model_ref, parse_rows(args.model_descriptor_rows_json)
    )
    provider_rows = parse_rows(args.provider_rows_json) + parse_rows(args.provider_pub_rows_json)
    cli_rows = parse_rows(args.cli_rows_json) + parse_rows(args.cli_pub_rows_json)

    providers = group_rows(provider_rows, "provider_id")
    clis = group_rows(cli_rows, "cli_id")
    descriptor_provider = (
        resolve_provider_by_ref(providers, requested_provider_ref)
        if requested_provider_ref
        else None
    )
    descriptor_cli = resolve_cli_for_provider(descriptor_provider, clis, model_override)
    if descriptor_provider is not None and descriptor_cli is None:
        raise RuntimeError("requested model provider has no matching CLI transport")

    # Resolution order:
    #   0. --cli-override (caller/picker selection via send input)  (INPUT, wins)
    #   1. selected-agent → ai-agent-profile.process_launch         (SSOT-correct)
    #   2. provider-primary → cli-registry.chat_launch              (provider fallback)
    # The input override is the proven model-override pattern applied to the
    # participant: it routes a picker selection to that CLI directly, independent of
    # the selected-agent find-current-items projection (which reflects admitted data,
    # not a live selection write — so selection alone never reached the producer).
    agent_id = cli_override or resolve_agent_id(selected_agent_rows)
    profile_instruction_snapshot = hydrate_profile_instructions(
        agent_id, profile_rows, instruction_rows, harness_materialization, request_id
    )
    instruction_receipt = profile_instruction_receipt(profile_instruction_snapshot)
    profile_launch: dict[str, Any] | None = None
    if agent_id:
        profile_launch = resolve_profile_launch(agent_id, profile_rows)

    # MODEL-OWNERSHIP ROUTING (one rule, all paths): a caller-chosen model that a
    # cli-registry row DECLARES always runs on a transport that owns it — unless
    # the resolved profile launch is itself pinned to exactly that model (then the
    # profile's own descriptor, env, accounts stay authoritative). Without this,
    # a profile process_launch would ride its own transport with a foreign model
    # id (burning the wrong engine's tokens). A chosen model NO row declares
    # keeps the explicitly-routed transport unchanged (fail-open for e.g. a
    # freshly pulled local model not yet re-discovered into the registry).
    def launch_pinned_to(launch: dict[str, Any], model_id: str) -> bool:
        return bool(model_id) and (
            as_string(launch.get("model")) == model_id
            or as_string(launch.get("model_id")) == model_id
        )

    model_owner_cli = resolve_cli_by_model(clis, model_override)
    if profile_launch is not None:
        if descriptor_cli is not None:
            profile_launch = None
        elif (
            descriptor_cli is None
            and model_owner_cli is not None
            and not launch_pinned_to(profile_launch, model_override)
        ):
            profile_launch = None

    # L090 DATA-driven output_kind: caller input wins; else this agent's profile
    # produce_output_kind; else "note". Lets a decoupled drainer forward only
    # agent_ref (no output_kind) yet still emit each agent's own record kind.
    if not output_kind:
        output_kind = resolve_profile_output_kind(agent_id, profile_rows) or "note"

    resolved_agent_label: str
    launch: dict[str, Any]
    model: str | None = None
    cli_id: str = "provider-fallback"

    if profile_launch is not None:
        # Agent path: profile owns the launch descriptor
        launch = profile_launch
        resolved_agent_label = agent_id or "selected-agent"
        # model from the launch context_defaults or left to the CLI defaults
        model = as_string(profile_launch.get("model")) or as_string(profile_launch.get("model_id"))
    else:
        # No matching agent profile. The selected-agent id may instead name a CLI
        # directly (the chat picker writes the chosen cli id into selected-agent
        # rather than owning a duplicate participant registry — L030). resolve_cli
        # prioritizes a requested id, so pass agent_id; when it is None or names a
        # profile that has no CLI match, resolve_cli falls back to provider-primary.
        explicitly_selected_cli = next(
            (candidate for candidate in clis if agent_id and cli_identity_matches(candidate, agent_id)), None
        )
        provider = descriptor_provider or (
            None if explicitly_selected_cli is not None or model_owner_cli is not None else resolve_provider(providers)
        )
        requested_cli = descriptor_cli or explicitly_selected_cli or resolve_cli(provider, clis, agent_id)
        model_cli = resolve_cli_by_model(clis, model_override)
        cli = requested_cli
        if descriptor_cli is None and model_cli is not None and (
            cli is None
            or not cli_supports_model(cli, model_override)
        ):
            cli = model_cli
        # L083 (maximally-capable default): the provider→CLI resolution may land on a
        # CLI that declares NO default model (e.g. when the substrate never wired
        # provider_ids, so resolve_cli falls back to clis[0]). If neither the provider
        # nor a caller override supplies a model, switch to the first CLI that DOES
        # declare a default model. This keeps `launch` and `model` consistent and
        # guarantees an unconfigured substrate still runs a real model instead of
        # failing with an empty `-m` — killing the whole empty-model category (L063).
        _provider_model = as_string(provider.get("prop:provider:model")) if isinstance(provider, dict) else None
        if (
            not model_override
            and not _provider_model
            and isinstance(cli, dict)
            and not first_default_model(cli.get("prop:cli_registry:models"))
        ):
            for _cand in clis:
                if isinstance(_cand, dict) and first_default_model(_cand.get("prop:cli_registry:models")):
                    cli = _cand
                    break
        if not isinstance(cli, dict):
            raise RuntimeError(
                "No selected agent profile launch and no CLI registry chat launch available"
            )
        launch_candidate = cli.get("prop:cli_registry:chat_launch")
        if not isinstance(launch_candidate, dict):
            raise RuntimeError("CLI registry entry has no chat_launch descriptor")
        launch = launch_candidate
        cli_id = as_string(cli.get("prop:cli_registry:cli")) or as_string(cli.get("subject_id")) or "unknown"
        # Label reflects whether the caller explicitly selected this cli or it came
        # from provider-primary resolution.
        if agent_id and cli_identity_matches(cli, agent_id):
            resolved_agent_label = f"selected-cli/{cli_id}"
        elif model_override and model_cli is cli:
            resolved_agent_label = f"model-routed/{cli_id}"
        else:
            resolved_agent_label = f"provider-fallback/{cli_id}"
        # Provider default model, then the resolved CLI's default. Treat an EMPTY
        # string (an unconfigured provider fact of `""`) as unset — otherwise it
        # satisfies `is not None` and blocks the CLI-default fallback, shipping
        # `-m ""` to the CLI (the exact bug that made an unconfigured substrate fail).
        if provider is not None:
            model = as_string(provider.get("prop:provider:model")) or None
        if not model:
            model = first_default_model(cli.get("prop:cli_registry:models"))

    # A caller-chosen model id (DATA) overrides the resolved default, so a picker
    # selection of a specific model is honored. Opaque id — no model names here.
    if model_override:
        model = model_override

    print(f"[ai-records-producer] resolved agent={resolved_agent_label} cli={cli_id} model={model or '(cli-default)'} wrap_ref={wrap_instruction_ref or '(none)'}")

    user_prompt = (wrap_prefix + instruction_text) if wrap_prefix else instruction_text
    base_prompt = profile_instruction_prompt(profile_instruction_snapshot) + user_prompt
    prompt = base_prompt + snapshot_prompt_suffix(addressed_input_snapshot)
    context: dict[str, Any] = {
        "prompt": prompt,
        "model": model,
        "resume": False,
        "projectPath": ".",
    }
    materialized_prompt = profile_instruction_snapshot.get("materialization")
    if isinstance(materialized_prompt, dict):
        system_prompt_transport = as_string(launch.get("system_prompt_transport"))
        if system_prompt_transport == "system-prompt-file-flag":
            context["system_prompt_path"] = (
                as_string(launch.get("system_prompt_path"))
                or DEFAULT_SYSTEM_PROMPT_MOUNT_PATH
            )
            context["system_prompt_content_hash"] = materialized_prompt["content_hash"]
        elif system_prompt_transport == "http-body-template":
            if as_string(launch.get("transport")) != "http":
                raise RuntimeError("http-body-template system prompt requires an http launch")
            prompt_file = as_string(args.harness_system_prompt_file)
            if prompt_file is None:
                raise RuntimeError("http-body-template system prompt requires a mounted prompt file")
            prompt_bytes = pathlib.Path(prompt_file).read_bytes()
            # Package-target replies are JSON encoded at the outside-work
            # boundary. A package-target reply artifact may contain one JSON
            # string rather than raw markdown. Unwrap that transport envelope
            # here; the materializer's direct CAS prompt mount remains valid.
            try:
                decoded_reply = json.loads(prompt_bytes)
            except (json.JSONDecodeError, UnicodeDecodeError):
                decoded_reply = None
            if isinstance(decoded_reply, str):
                prompt_bytes = decoded_reply.encode("utf-8")
            expected_bytes = materialized_prompt.get("bytes")
            if not isinstance(expected_bytes, int) or len(prompt_bytes) != expected_bytes:
                raise RuntimeError(
                    "mounted system prompt byte count does not match materialization receipt"
                )
            try:
                context["system_prompt"] = prompt_bytes.decode("utf-8")
            except UnicodeDecodeError as error:
                raise RuntimeError("mounted system prompt must be UTF-8") from error
            context["system_prompt_content_hash"] = materialized_prompt["content_hash"]
        else:
            raise RuntimeError(
                "selected transport does not support hash-only system-prompt delivery"
            )
    # Merge the open parameter bag into the launch-rendering context. Structural
    # keys are set FIRST, and already-set keys win — that ordering (not an
    # enumerated reserved list) is what stops a parameter from shadowing the
    # prompt or the resolved model. Every merged key is immediately usable by
    # launch DATA: argv `{value:"<key>","when":"<key>"}` and http `{<key>}`.
    for key, value in parameters.items():
        if not isinstance(key, str) or not key or key in context:
            continue
        context[key] = scalar_text(value)

    request = {
        "request_id": request_id or None,  # the records step addresses result::{request_id}
        "partition_key": args.partition_key,
        "instruction_text": instruction_text,
        "instruction_observability": instruction_receipt,
        "addressed_input_snapshot": addressed_input_snapshot,
        "prompt_hash": sha256_text(prompt),
        "system_prompt_content_hash": (
            materialized_prompt.get("content_hash")
            if isinstance(materialized_prompt, dict) else None
        ),
        # Opaque pass-through of the caller's routing ref. The result contract
        # REQUIRES target_group_ref and the records step stamps it from
        # request.get("target_group_ref") — dropping it here left every result
        # with target_group_ref:null, breaking any consumer that routes a result
        # back to its origin (e.g. a conversational reply's chat). Never
        # interpreted by this script.
        "target_group_ref": as_string(input_obj.get("target_group_ref")) or None,
        "output_kind": output_kind,
        "wrap_instruction_ref": wrap_instruction_ref,
        "resolved_agent": resolved_agent_label,
        "cli_id": cli_id,
        "model_id": model,
        # DATA pass-through of the CLI's optional stream text-extraction spec (a
        # stream-json CLI carries one; a plain-prose CLI omits it -> None). The
        # streaming result_payload forwards it so a live subscriber can pull text
        # from raw JSONL. This script never interprets it.
        "stream_parse_spec": launch.get("stream_parse_spec"),
        # DATA-selected model transport (L090): {slot, payload, response_path}.
        # CLI models -> {slot:"compute.process", payload:<process descriptor>};
        # cloud models -> {slot:"slot::http-client", payload:<http descriptor>}.
        "transport": build_transport(launch, context, None),
    }

    pathlib.Path(args.output_json).write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
