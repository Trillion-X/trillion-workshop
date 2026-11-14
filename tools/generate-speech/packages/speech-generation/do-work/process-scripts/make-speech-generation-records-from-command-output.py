#!/usr/bin/env python3
"""Make speech generation records from external command output."""

from __future__ import annotations

import argparse
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


def write_json(path: str, value: dict[str, Any]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))


def object_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def list_or_empty(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def request_id(request: dict[str, Any]) -> str:
    value = request.get("request_id")
    return str(value) if value not in (None, "") else "unknown-request"


def address_token(value: Any, fallback: str) -> str:
    raw = str(value) if value not in (None, "") else fallback
    return "".join(ch if ch.isalnum() or ch in "._:-" else "_" for ch in raw)


def observed_at(request: dict[str, Any]) -> str | None:
    value = request.get("requested_at") or request.get("created_at")
    return str(value) if value not in (None, "") else None


def voice_profile_ref(request: dict[str, Any]) -> Any:
    return request.get("voice_profile_ref")


def voice_profile_approval_ref(request: dict[str, Any]) -> Any:
    return request.get("voice_profile_approval_ref")


def artifact_refs(value: Any) -> list[dict[str, Any]]:
    return [
        item
        for item in list_or_empty(value)
        if isinstance(item, dict) and item.get("multihash") not in (None, "")
    ]


def artifact_ref_list_is_valid(value: Any) -> bool:
    return isinstance(value, list) and len(artifact_refs(value)) == len(value)


def record(address: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"address": address, "path": PUBLISHED_PATH, "payload": payload}


def error_record(
    request: dict[str, Any],
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rid = request_id(request)
    payload: dict[str, Any] = {
        "kind": "speech-generation.error",
        "request_id": rid,
        "voice_profile_ref": voice_profile_ref(request),
        "voice_profile_approval_ref": voice_profile_approval_ref(request),
        "code": code,
        "message": message,
        "observed_at": observed_at(request),
    }
    if details:
        payload["details"] = details
    return record(f"package::speech-generation::error::{address_token(rid, 'request')}", payload)


def canonical_records_from_command(request: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]]:
    if voice_profile_ref(request) in (None, ""):
        return [
            error_record(
                request,
                "speech_generation_missing_voice_profile_ref",
                "Speech generation requests must use an explicit approved voice_profile_ref.",
            )
        ]
    if voice_profile_approval_ref(request) in (None, ""):
        return [
            error_record(
                request,
                "speech_generation_missing_voice_profile_approval_ref",
                "Speech generation requests must carry approval evidence for the voice profile.",
            )
        ]
    has_reference_refs = "reference_artifact_refs" in request
    if has_reference_refs and not artifact_ref_list_is_valid(request.get("reference_artifact_refs")):
        return [
            error_record(
                request,
                "speech_generation_invalid_reference_artifact_refs",
                "Reference audio must be supplied as artifact refs with multihash fields.",
            )
        ]

    provided_records = [item for item in list_or_empty(result.get("records")) if isinstance(item, dict)]
    if provided_records:
        return [
            {
                "address": str(item.get("address")),
                "path": list_or_empty(item.get("path")) or PUBLISHED_PATH,
                "payload": object_or_empty(item.get("payload")),
            }
            for item in provided_records
            if item.get("address") and isinstance(item.get("payload"), dict)
        ]

    if not artifact_ref_list_is_valid(result.get("output_artifact_refs")):
        return [
            error_record(
                request,
                "speech_generation_command_output_missing_artifacts",
                "Speech generation command output must contain output_artifact_refs with multihash fields or canonical records.",
                {"available_keys": sorted(str(key) for key in result.keys())},
            )
        ]
    output_refs = artifact_refs(result.get("output_artifact_refs"))

    rid = request_id(request)
    options = object_or_empty(request.get("options"))
    payload = {
        "kind": "speech-generation.result",
        "request_id": rid,
        "voice_profile_ref": voice_profile_ref(request),
        "voice_profile_approval_ref": voice_profile_approval_ref(request),
        "command_run_id": result.get(
            "command_run_id",
            f"package::speech-generation::command-run-request::{address_token(rid, 'request')}",
        ),
        "language": str(result.get("language") or options.get("language") or "und"),
        "format": str(result.get("format") or options.get("format") or "audio/unknown"),
        "duration_ms": result.get("duration_ms"),
        "output_artifact_refs": output_refs,
        "completed_at": str(result.get("completed_at") or observed_at(request) or ""),
    }
    return [record(f"package::speech-generation::result::{address_token(rid, 'request')}", payload)]


def build_output(request: dict[str, Any], command_output: dict[str, Any]) -> dict[str, Any]:
    records = canonical_records_from_command(request, command_output)
    return {
        "kind": "speech-generation.records-from-command-run",
        "request_id": request_id(request),
        "records": records,
        "summary": {
            "record_count": len(records),
            "command_output_supplied": True,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-json", required=True)
    parser.add_argument("--command-output-json", required=True)
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()

    try:
        request = read_json(args.request_json)
        command_output = read_json(args.command_output_json)
        write_json(args.output_json, build_output(request, command_output))
        return 0
    except Exception as exc:  # pragma: no cover - keeps workflow output machine-readable.
        fallback_request = {}
        try:
            fallback_request = read_json(args.request_json)
        except Exception:
            pass
        fallback = {
            "kind": "speech-generation.records-from-command-run",
            "request_id": request_id(fallback_request),
            "records": [
                error_record(
                    fallback_request,
                    "command_output_record_maker_crash",
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
