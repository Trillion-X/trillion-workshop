#!/usr/bin/env python3
"""Make media identity records from external command output."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


PUBLISHED_PATH = ["current-item", "published-record"]
MEDIA_IDENTITY_KINDS = {
    "media-identity.signature",
    "media-identity.cluster",
    "media-identity.profile-binding",
    "media-identity.match",
    "media-identity.error",
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


def request_id(request: dict[str, Any]) -> str:
    value = request.get("request_id")
    return str(value) if value not in (None, "") else "unknown-request"


def address_token(value: Any, fallback: str) -> str:
    raw = str(value) if value not in (None, "") else fallback
    return "".join(ch if ch.isalnum() or ch in "._:-" else "_" for ch in raw)


def source_artifact_ref(request: dict[str, Any]) -> dict[str, Any]:
    return object_or_empty(object_or_empty(request.get("source")).get("artifact_ref"))


def source_fingerprint(request: dict[str, Any]) -> str:
    source = object_or_empty(request.get("source"))
    ref = source_artifact_ref(request)
    for value in (
        source.get("asset_id"),
        ref.get("multihash"),
        ref.get("cas_address"),
        ref.get("content_hash"),
        ref.get("sha256"),
    ):
        if value not in (None, ""):
            return str(value)
    return request_id(request)


def command_run_id(request: dict[str, Any], item: dict[str, Any] | None = None) -> str:
    data = object_or_empty(item)
    return str(data.get("command_run_id") or f"package::media-identity::command-run-request::{address_token(request_id(request), 'request')}")


def observed_at(request: dict[str, Any]) -> str | None:
    value = request.get("requested_at") or request.get("created_at")
    return str(value) if value not in (None, "") else None


def record(address: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"address": address, "path": PUBLISHED_PATH, "payload": payload}


def float_or_default(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def ref_from(value: Any, kind: str, key: str) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if value in (None, ""):
        return {}
    return {"kind": kind, key: str(value)}


def error_record(
    request: dict[str, Any],
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rid = request_id(request)
    payload: dict[str, Any] = {
        "kind": "media-identity.error",
        "request_id": rid,
        "source_artifact_ref": source_artifact_ref(request),
        "source_fingerprint": source_fingerprint(request),
        "command_run_id": command_run_id(request),
        "code": code,
        "message": message,
        "observed_at": observed_at(request),
    }
    if details:
        payload["details"] = details
    return record(f"package::media-identity::error::{address_token(rid, 'request')}", payload)


def signature_record(request: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    rid = request_id(request)
    signature_id = str(item.get("signature_id") or f"{rid}:signature:{index}")
    payload = {
        "kind": "media-identity.signature",
        "signature_id": signature_id,
        "request_id": rid,
        "source_artifact_ref": source_artifact_ref(request),
        "source_fingerprint": source_fingerprint(request),
        "command_run_id": command_run_id(request, item),
        "source_span": object_or_empty(item.get("source_span") or item.get("span")),
        "modality": str(item.get("modality") or "identity"),
        "signature_artifact_ref": object_or_empty(item.get("signature_artifact_ref") or item.get("artifact_ref")),
        "model": object_or_empty(item.get("model")),
        "quality": object_or_empty(item.get("quality")),
        "evidence": item.get("evidence", {}),
        "created_at": str(item.get("created_at") or observed_at(request) or ""),
    }
    return record(f"package::media-identity::signature::{address_token(signature_id, f'signature-{index}')}", payload)


def cluster_record(request: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    rid = request_id(request)
    cluster_id = str(item.get("cluster_id") or f"{rid}:cluster:{index}")
    payload = {
        "kind": "media-identity.cluster",
        "cluster_id": cluster_id,
        "command_run_id": command_run_id(request, item),
        "modality_mix": object_or_empty(item.get("modality_mix")),
        "member_signature_refs": list_or_empty(item.get("member_signature_refs")),
        "centroid_artifact_ref": object_or_empty(item.get("centroid_artifact_ref")),
        "profile_binding_refs": list_or_empty(item.get("profile_binding_refs")),
        "status": str(item.get("status") or "unknown"),
        "evidence": item.get("evidence", {}),
        "updated_at": str(item.get("updated_at") or observed_at(request) or ""),
    }
    return record(f"package::media-identity::cluster::{address_token(cluster_id, f'cluster-{index}')}", payload)


def match_record(request: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    rid = request_id(request)
    match_id = str(item.get("match_id") or f"{rid}:match:{index}")
    signature_ref = item.get("signature_ref") or item.get("signature_id")
    cluster_ref = item.get("cluster_ref") or item.get("cluster_id")
    payload = {
        "kind": "media-identity.match",
        "match_id": match_id,
        "request_id": rid,
        "source_artifact_ref": source_artifact_ref(request),
        "source_fingerprint": source_fingerprint(request),
        "command_run_id": command_run_id(request, item),
        "signature_ref": ref_from(signature_ref, "media-identity.signature-ref", "signature_id"),
        "cluster_ref": ref_from(cluster_ref, "media-identity.cluster-ref", "cluster_id"),
        "profile_ref": ref_from(item.get("profile_ref") or item.get("profile_id"), "media-identity.profile-ref", "profile_id"),
        "profile_binding_ref": ref_from(item.get("profile_binding_ref") or item.get("binding_id"), "media-identity.profile-binding-ref", "binding_id"),
        "source_span": object_or_empty(item.get("source_span") or item.get("span")),
        "confidence": float_or_default(item.get("confidence"), 0.0),
        "evidence": item.get("evidence", {}),
        "created_at": str(item.get("created_at") or observed_at(request) or ""),
    }
    return record(f"package::media-identity::match::{address_token(match_id, f'match-{index}')}", payload)


def normalize_provided_records(request: dict[str, Any], provided_records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for item in provided_records:
        payload = object_or_empty(item.get("payload"))
        if not item.get("address") or not payload:
            continue
        if payload.get("kind") in MEDIA_IDENTITY_KINDS:
            payload.setdefault("request_id", request_id(request))
            payload.setdefault("command_run_id", command_run_id(request, payload))
            if payload.get("kind") in {"media-identity.signature", "media-identity.match", "media-identity.error"}:
                payload.setdefault("source_artifact_ref", source_artifact_ref(request))
                payload.setdefault("source_fingerprint", source_fingerprint(request))
        records.append({
            "address": str(item.get("address")),
            "path": list_or_empty(item.get("path")) or PUBLISHED_PATH,
            "payload": payload,
        })
    return records


def canonical_records_from_command(request: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]]:
    provided_records = [item for item in list_or_empty(result.get("records")) if isinstance(item, dict)]
    if provided_records:
        return normalize_provided_records(request, provided_records)

    records: list[dict[str, Any]] = []
    for index, item in enumerate(item for item in list_or_empty(result.get("signatures")) if isinstance(item, dict)):
        records.append(signature_record(request, item, index))
    for index, item in enumerate(item for item in list_or_empty(result.get("clusters")) if isinstance(item, dict)):
        records.append(cluster_record(request, item, index))
    for index, item in enumerate(item for item in list_or_empty(result.get("matches")) if isinstance(item, dict)):
        records.append(match_record(request, item, index))

    if records:
        return records

    return [
        error_record(
            request,
            "no_records_emitted",
            "Media identity command output did not contain signatures, clusters, matches, or canonical records.",
            {"available_keys": sorted(str(key) for key in result.keys())},
        )
    ]


def build_output(request: dict[str, Any], command_output: dict[str, Any]) -> dict[str, Any]:
    records = canonical_records_from_command(request, command_output)
    return {
        "kind": "media-identity.records-from-command-run",
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
            "kind": "media-identity.records-from-command-run",
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
