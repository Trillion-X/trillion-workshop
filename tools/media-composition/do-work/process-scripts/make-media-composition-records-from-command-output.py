#!/usr/bin/env python3
"""Make media-composition records from external planner command output."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


PUBLISHED_PATH = ["current-item", "published-record"]
MEDIA_COMPOSITION_KINDS = {
    "media-composition.selection",
    "media-composition.plan",
    "media-composition.render-manifest",
    "media-composition.handoff",
    "media-composition.error",
}


def read_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("JSON input must be an object")
    return value


def write_json(path: str, value: dict[str, Any]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))


def object_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def list_or_empty(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def intent_id(intent: dict[str, Any]) -> str:
    value = intent.get("intent_id")
    return str(value) if value not in (None, "") else "unknown-intent"


def address_token(value: Any, fallback: str) -> str:
    raw = str(value) if value not in (None, "") else fallback
    return "".join(ch if ch.isalnum() or ch in "._:-" else "_" for ch in raw)


def observed_at(intent: dict[str, Any]) -> str | None:
    value = intent.get("requested_at") or intent.get("created_at")
    return str(value) if value not in (None, "") else None


def composition_run_id(intent: dict[str, Any], item: dict[str, Any] | None = None) -> str:
    data = object_or_empty(item)
    return str(data.get("composition_run_id") or f"package::media-composition::composition-run::{address_token(intent_id(intent), 'intent')}")


def record(address: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"address": address, "path": PUBLISHED_PATH, "payload": payload}


def ref_from(value: Any, kind: str, key: str) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if value in (None, ""):
        return {}
    return {"kind": kind, key: str(value)}


def artifact_refs(value: Any) -> list[dict[str, Any]]:
    return [
        item
        for item in list_or_empty(value)
        if isinstance(item, dict) and item.get("multihash") not in (None, "")
    ]


def artifact_ref_list_is_valid(value: Any) -> bool:
    return isinstance(value, list) and len(artifact_refs(value)) == len(value)


def error_record(
    intent: dict[str, Any],
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    iid = intent_id(intent)
    payload: dict[str, Any] = {
        "kind": "media-composition.error",
        "intent_id": iid,
        "composition_run_id": composition_run_id(intent),
        "code": code,
        "message": message,
        "observed_at": observed_at(intent),
    }
    if details:
        payload["details"] = details
    return record(f"package::media-composition::error::{address_token(iid, 'intent')}", payload)


def selection_record(intent: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    iid = intent_id(intent)
    selection_id = str(item.get("selection_id") or f"{iid}:selection:{index}")
    payload = {
        "kind": "media-composition.selection",
        "selection_id": selection_id,
        "intent_id": iid,
        "composition_run_id": composition_run_id(intent, item),
        "source_span_refs": list_or_empty(item.get("source_span_refs")),
        "evidence_refs": list_or_empty(item.get("evidence_refs")),
        "selection_profile_ref": object_or_empty(item.get("selection_profile_ref")),
        "created_at": str(item.get("created_at") or observed_at(intent) or ""),
    }
    return record(f"package::media-composition::selection::{address_token(selection_id, f'selection-{index}')}", payload)


def plan_record(intent: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    iid = intent_id(intent)
    plan_id = str(item.get("plan_id") or f"{iid}:plan:{index}")
    payload = {
        "kind": "media-composition.plan",
        "plan_id": plan_id,
        "intent_id": iid,
        "composition_run_id": composition_run_id(intent, item),
        "selection_refs": list_or_empty(item.get("selection_refs")),
        "asset_spans": list_or_empty(item.get("asset_spans")),
        "overlays": list_or_empty(item.get("overlays")),
        "narration_refs": list_or_empty(item.get("narration_refs")),
        "caption_refs": list_or_empty(item.get("caption_refs")),
        "layout_intent": object_or_empty(item.get("layout_intent")),
        "output_profile": object_or_empty(item.get("output_profile") or intent.get("output_profile")),
        "renderer_profile_ref": object_or_empty(item.get("renderer_profile_ref")),
        "created_at": str(item.get("created_at") or observed_at(intent) or ""),
    }
    return record(f"package::media-composition::plan::{address_token(plan_id, f'plan-{index}')}", payload)


def render_manifest_record(intent: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    iid = intent_id(intent)
    manifest_id = str(item.get("manifest_id") or f"{iid}:render-manifest:{index}")
    renderer_ref = ref_from(
        item.get("renderer_ref") or item.get("renderer_profile_ref"),
        "media-composition.renderer-ref",
        "renderer_id",
    )
    payload = {
        "kind": "media-composition.render-manifest",
        "manifest_id": manifest_id,
        "intent_id": iid,
        "composition_run_id": composition_run_id(intent, item),
        "plan_ref": ref_from(item.get("plan_ref") or item.get("plan_id"), "media-composition.plan-ref", "plan_id"),
        "renderer_ref": renderer_ref,
        "input_artifact_refs": artifact_refs(item.get("input_artifact_refs")),
        "render_graph": object_or_empty(item.get("render_graph")),
        "output_profile": object_or_empty(item.get("output_profile") or intent.get("output_profile")),
        "created_at": str(item.get("created_at") or observed_at(intent) or ""),
    }
    return record(f"package::media-composition::render-manifest::{address_token(manifest_id, f'manifest-{index}')}", payload)


def handoff_record(intent: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    iid = intent_id(intent)
    handoff_id = str(item.get("handoff_id") or f"{iid}:handoff:{index}")
    payload = {
        "kind": "media-composition.handoff",
        "handoff_id": handoff_id,
        "intent_id": iid,
        "composition_run_id": composition_run_id(intent, item),
        "target_package_ref": ref_from(item.get("target_package_ref"), "media-composition.target-package-ref", "package"),
        "target_action_ref": ref_from(item.get("target_action_ref"), "media-composition.target-action-ref", "action_id"),
        "manifest_ref": ref_from(item.get("manifest_ref") or item.get("manifest_id"), "media-composition.render-manifest-ref", "manifest_id"),
        "state": str(item.get("state") or "ready"),
        "created_at": str(item.get("created_at") or observed_at(intent) or ""),
    }
    return record(f"package::media-composition::handoff::{address_token(handoff_id, f'handoff-{index}')}", payload)


def error_from_item(intent: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    return error_record(
        intent,
        str(item.get("code") or f"media_composition_error_{index}"),
        str(item.get("message") or "Media composition planner returned an error."),
        object_or_empty(item.get("details")),
    )


def validated_provided_record(intent: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    address = item.get("address")
    payload = object_or_empty(item.get("payload"))
    kind = payload.get("kind")
    if address in (None, ""):
        return error_record(
            intent,
            "media_composition_provided_record_missing_address",
            "Canonical media-composition records must include an address.",
            {"record_index": index},
        )
    if kind not in MEDIA_COMPOSITION_KINDS:
        return error_record(
            intent,
            "media_composition_provided_record_unsupported_kind",
            "Canonical media-composition records must use a package-owned kind.",
            {"record_index": index, "kind": kind},
        )
    if kind == "media-composition.render-manifest":
        if not object_or_empty(payload.get("renderer_ref")):
            return error_record(
                intent,
                "media_composition_manifest_missing_renderer_ref",
                "Render manifests must select renderer_ref by data.",
                {"record_index": index},
            )
        if "input_artifact_refs" in payload and not artifact_ref_list_is_valid(payload.get("input_artifact_refs")):
            return error_record(
                intent,
                "media_composition_manifest_invalid_artifact_refs",
                "Render manifest input_artifact_refs must be artifact refs with multihash fields.",
                {"record_index": index},
            )
    return {
        "address": str(address),
        "path": list_or_empty(item.get("path")) or PUBLISHED_PATH,
        "payload": payload,
    }


def canonical_records_from_command(intent: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]]:
    provided_records = [item for item in list_or_empty(result.get("records")) if isinstance(item, dict)]
    if provided_records:
        return [validated_provided_record(intent, item, index) for index, item in enumerate(provided_records)]

    records: list[dict[str, Any]] = []
    for index, item in enumerate(item for item in list_or_empty(result.get("selections")) if isinstance(item, dict)):
        records.append(selection_record(intent, item, index))
    for index, item in enumerate(item for item in list_or_empty(result.get("plans")) if isinstance(item, dict)):
        records.append(plan_record(intent, item, index))
    for index, item in enumerate(item for item in list_or_empty(result.get("render_manifests")) if isinstance(item, dict)):
        if not item.get("renderer_ref") and not item.get("renderer_profile_ref"):
            records.append(error_record(intent, "media_composition_manifest_missing_renderer_ref", "Render manifests must select renderer_ref by data."))
        elif "input_artifact_refs" in item and not artifact_ref_list_is_valid(item.get("input_artifact_refs")):
            records.append(error_record(intent, "media_composition_manifest_invalid_artifact_refs", "Render manifest input_artifact_refs must be artifact refs with multihash fields."))
        else:
            records.append(render_manifest_record(intent, item, index))
    for index, item in enumerate(item for item in list_or_empty(result.get("handoffs")) if isinstance(item, dict)):
        records.append(handoff_record(intent, item, index))
    for index, item in enumerate(item for item in list_or_empty(result.get("errors")) if isinstance(item, dict)):
        records.append(error_from_item(intent, item, index))

    if records:
        return records
    return [
        error_record(
            intent,
            "media_composition_command_output_empty",
            "Media composition command output must contain selections, plans, render_manifests, handoffs, errors, or canonical records.",
            {"available_keys": sorted(str(key) for key in result.keys())},
        )
    ]


def build_output(intent: dict[str, Any], command_output: dict[str, Any]) -> dict[str, Any]:
    records = canonical_records_from_command(intent, command_output)
    return {
        "kind": "media-composition.records-from-command-run",
        "intent_id": intent_id(intent),
        "records": records,
        "summary": {
            "record_count": len(records),
            "command_output_supplied": True,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--intent-json", required=True)
    parser.add_argument("--command-output-json", required=True)
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()

    try:
        intent = read_json(args.intent_json)
        command_output = read_json(args.command_output_json)
        write_json(args.output_json, build_output(intent, command_output))
        return 0
    except Exception as exc:  # pragma: no cover - keeps workflow output machine-readable.
        fallback_intent = {}
        try:
            fallback_intent = read_json(args.intent_json)
        except Exception:
            pass
        fallback = {
            "kind": "media-composition.records-from-command-run",
            "intent_id": intent_id(fallback_intent),
            "records": [
                error_record(
                    fallback_intent,
                    "media_composition_record_maker_crash",
                    str(exc),
                    {"command_output_json": args.command_output_json},
                )
            ],
        }
        write_json(args.output_json, fallback)
        print(str(exc), file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
