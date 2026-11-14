#!/usr/bin/env python3
"""Make media analysis records from external command output."""

from __future__ import annotations

import argparse
import base64
import json
import struct
import sys
from pathlib import Path
from typing import Any


PUBLISHED_PATH = ["current-item", "published-record"]
MEDIA_EVIDENCE_KINDS = {
    "media-analysis.claim",
    "media-analysis.embedding",
    "media-analysis.chapter",
    "media-analysis.thumbnail",
    "media-analysis.error",
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


def source_asset_id(request: dict[str, Any]) -> str:
    return source_fingerprint(request)


def command_run_id(request: dict[str, Any], item: dict[str, Any] | None = None) -> str:
    data = object_or_empty(item)
    return str(data.get("command_run_id") or f"package::media-analysis::command-run-request::{address_token(request_id(request), 'request')}")


def observed_at(request: dict[str, Any]) -> str | None:
    value = request.get("requested_at") or request.get("created_at")
    return str(value) if value not in (None, "") else None


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
        "kind": "media-analysis.error",
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
    return record(f"package::media-analysis::error::{address_token(rid, 'request')}", payload)


def float_or_default(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def claim_record(request: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    rid = request_id(request)
    claim_id = str(item.get("claim_id") or f"{rid}:claim:{index}")
    payload = {
        "kind": "media-analysis.claim",
        "claim_id": claim_id,
        "request_id": rid,
        "source_artifact_ref": source_artifact_ref(request),
        "source_fingerprint": source_fingerprint(request),
        "command_run_id": command_run_id(request, item),
        "asset_id": source_asset_id(request),
        "claim_type": str(item.get("claim_type") or item.get("type") or "media.claim"),
        "claim_key": str(item.get("claim_key") or item.get("key") or claim_id),
        "confidence": float_or_default(item.get("confidence"), 1.0),
        "evidence": item.get("evidence", {}),
        "value": item.get("value"),
        "created_at": str(item.get("created_at") or observed_at(request) or ""),
    }
    return record(f"package::media-analysis::claim::{address_token(claim_id, f'claim-{index}')}", payload)


def index_ready_vector_base64(item: dict[str, Any]) -> str:
    """Self-describing index handoff (L090): decode the artifact ref's raw
    float32 bytes into the base64(JSON {"vector":[...]}) shape that
    meaning-search's index-content `content_vector_base64` input consumes, so a
    trigger rule can bind the record field straight into the dispatch with zero
    byte-decoding ops in trigger grammar."""
    ref = object_or_empty(item.get("vector_artifact_ref"))
    raw_b64 = ref.get("bytes_base64")
    if not isinstance(raw_b64, str) or not raw_b64:
        return ""
    try:
        raw = base64.b64decode(raw_b64)
        count = len(raw) // 4
        if count == 0 or len(raw) % 4 != 0:
            return ""
        vector = [float(value) for value in struct.unpack(f"<{count}f", raw)]
        # Provenance MUST travel with the vector (L090 self-describing): meaning-search's
        # index-content-vector `make-embedding-facts` step hard-requires model_id, and the
        # precomputed-vector path has no descriptor to read it from — so carry it inline.
        model = object_or_empty(item.get("model"))
        payload: dict[str, Any] = {"vector": vector}
        model_id = str(model.get("name") or "")
        model_version = str(model.get("pretrained") or "")
        if model_id:
            payload["model_id"] = model_id
        if model_version:
            payload["model_version"] = model_version
        return base64.b64encode(
            json.dumps(payload, separators=(",", ":")).encode("utf-8")
        ).decode("ascii")
    except Exception:
        return ""


def embedding_record(
    request: dict[str, Any],
    item: dict[str, Any],
    index: int,
    process_output_hashes: dict[str, str] | None = None,
) -> dict[str, Any]:
    process_output_hashes = process_output_hashes or {}
    rid = request_id(request)
    embedding_id = str(item.get("embedding_id") or f"{rid}:embedding:{index}")
    payload = {
        "kind": "media-analysis.embedding",
        "embedding_id": embedding_id,
        "request_id": rid,
        "source_artifact_ref": source_artifact_ref(request),
        "source_fingerprint": source_fingerprint(request),
        "command_run_id": command_run_id(request, item),
        "asset_id": str(item.get("asset_id") or source_asset_id(request)),
        "modality": str(item.get("modality") or "media"),
        "model": object_or_empty(item.get("model")),
        "time_range": object_or_empty(item.get("time_range")),
        "sampling": object_or_empty(item.get("sampling")),
        "vector_artifact_ref": object_or_empty(item.get("vector_artifact_ref")),
        "content_vector_base64": index_ready_vector_base64(item),
        "time_offset_seconds": float_or_default(item.get("time_offset_seconds")),
        "created_at": str(item.get("created_at") or observed_at(request) or ""),
    }
    # Self-describing renderable preview (L090 + thumbnail contract: bytes live
    # in artifact_ref/CAS, never inline): join the producer's sheet mount path
    # against the process outputs' integrity hashes; the record carries only the
    # CAS address + this frame's tiny sheet region.
    sheet_mount = str(item.get("preview_sheet_mount_path") or "")
    sheet_hash = process_output_hashes.get(sheet_mount, "") if sheet_mount else ""
    region = object_or_empty(item.get("preview_region"))
    if sheet_hash and region:
        payload["preview_artifact_ref"] = {"cas_address": sheet_hash, "media_type": "image/jpeg"}
        payload["preview_region"] = region
    address = f"package::media-analysis::embedding::{address_token(embedding_id, f'embedding-{index}')}"
    # Self-describing index handoff (L090): the record carries its own address so
    # trigger rules can bind content_address directly (trigger grammar has no
    # string-concat operator).
    payload["content_address"] = address
    return record(address, payload)


def chapter_record(request: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    rid = request_id(request)
    chapter_id = str(item.get("chapter_id") or f"{rid}:chapter:{index}")
    payload = {
        "kind": "media-analysis.chapter",
        "chapter_id": chapter_id,
        "request_id": rid,
        "source_artifact_ref": source_artifact_ref(request),
        "source_fingerprint": source_fingerprint(request),
        "command_run_id": command_run_id(request, item),
        "asset_id": source_asset_id(request),
        "title": str(item.get("title") or f"Chapter {index + 1}"),
        "summary": str(item.get("summary") or ""),
        "start_time": float_or_default(item.get("start_time", item.get("start"))),
        "end_time": float_or_default(item.get("end_time", item.get("end"))),
        "evidence": item.get("evidence", {}),
        "created_at": str(item.get("created_at") or observed_at(request) or ""),
    }
    return record(f"package::media-analysis::chapter::{address_token(chapter_id, f'chapter-{index}')}", payload)


def thumbnail_record(request: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    rid = request_id(request)
    thumbnail_id = str(item.get("thumbnail_id") or f"{rid}:thumbnail:{index}")
    payload = {
        "kind": "media-analysis.thumbnail",
        "thumbnail_id": thumbnail_id,
        "request_id": rid,
        "source_artifact_ref": source_artifact_ref(request),
        "source_fingerprint": source_fingerprint(request),
        "command_run_id": command_run_id(request, item),
        "asset_id": source_asset_id(request),
        "time": float_or_default(item.get("time", item.get("start_time"))),
        "artifact_ref": object_or_empty(item.get("artifact_ref")),
        "evidence": item.get("evidence", {}),
        "created_at": str(item.get("created_at") or observed_at(request) or ""),
    }
    return record(f"package::media-analysis::thumbnail::{address_token(thumbnail_id, f'thumbnail-{index}')}", payload)


def process_output_hash_map(process_outputs: Any) -> dict[str, str]:
    """Map each declared process output's mount_path -> integrity_hash (the CAS
    address the engine staged its bytes under for addressed_chunks outputs).
    Accepts the step reply's `output.outputs` array; tolerant of anything else."""
    hashes: dict[str, str] = {}
    for entry in list_or_empty(process_outputs):
        data = object_or_empty(entry)
        mount = str(data.get("mount_path") or "")
        digest = str(data.get("integrity_hash") or "")
        if mount and digest:
            hashes[mount] = digest
    return hashes


def canonical_records_from_command(
    request: dict[str, Any],
    result: dict[str, Any],
    process_output_hashes: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    provided_records = [item for item in list_or_empty(result.get("records")) if isinstance(item, dict)]
    if provided_records:
        records: list[dict[str, Any]] = []
        for item in provided_records:
            payload = object_or_empty(item.get("payload"))
            if not item.get("address") or not payload:
                continue
            if payload.get("kind") in MEDIA_EVIDENCE_KINDS:
                payload.setdefault("source_artifact_ref", source_artifact_ref(request))
                payload.setdefault("source_fingerprint", source_fingerprint(request))
                payload.setdefault("command_run_id", command_run_id(request, payload))
            records.append({
                "address": str(item.get("address")),
                "path": list_or_empty(item.get("path")) or PUBLISHED_PATH,
                "payload": payload,
            })
        return records

    records: list[dict[str, Any]] = []
    for index, item in enumerate(list_or_empty(result.get("claims"))):
        records.append(claim_record(request, object_or_empty(item), index))
    for index, item in enumerate(list_or_empty(result.get("embeddings"))):
        records.append(embedding_record(request, object_or_empty(item), index, process_output_hashes))
    for index, item in enumerate(list_or_empty(result.get("chapters"))):
        records.append(chapter_record(request, object_or_empty(item), index))
    for index, item in enumerate(list_or_empty(result.get("thumbnails"))):
        records.append(thumbnail_record(request, object_or_empty(item), index))
    for item in list_or_empty(result.get("errors")):
        data = object_or_empty(item)
        records.append(error_record(request, str(data.get("code") or "analysis_command_error"), str(data.get("message") or "Media analysis command error."), data))
    return records or [error_record(request, "no_records_emitted", "Media analysis produced no evidence records.")]


def build_output(
    request: dict[str, Any],
    command_output: dict[str, Any],
    process_output_hashes: dict[str, str] | None = None,
) -> dict[str, Any]:
    records = canonical_records_from_command(request, command_output, process_output_hashes)
    return {
        "kind": "media-analysis.records-from-command-run",
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
    # Optional: the command step's declared process outputs (JSON array of
    # {mount_path, integrity_hash, ...}) so records can reference CAS-staged
    # artifacts (e.g. the preview sheet) by address instead of inlining bytes.
    parser.add_argument("--process-outputs-json", required=False, default=None)
    args = parser.parse_args()

    try:
        request = read_json(args.request_json)
        command_output = read_json(args.command_output_json)
        hashes: dict[str, str] = {}
        if args.process_outputs_json:
            try:
                with open(args.process_outputs_json, "r", encoding="utf-8") as handle:
                    hashes = process_output_hash_map(json.load(handle))
            except Exception:
                hashes = {}
        write_json(args.output_json, build_output(request, command_output, hashes))
        return 0
    except Exception as exc:  # pragma: no cover - keeps workflow JSON-shaped on record-making defects.
        fallback_request = {}
        try:
            fallback_request = read_json(args.request_json)
        except Exception:
            pass
        fallback = {
            "kind": "media-analysis.records-from-command-run",
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
