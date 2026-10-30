#!/usr/bin/env python3
"""Make audio transcription records from external command output."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


PUBLISHED_PATH = ["audio-transcription", "content-media-evidence"]


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
    artifact_ref = source_artifact_ref(request)
    for key in ("integrity_hash", "multihash", "cas_address", "content_hash", "sha256"):
        value = artifact_ref.get(key)
        if value not in (None, ""):
            return str(value)
    return request_id(request)


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
        "kind": "audio-transcription.error",
        "role": "errors",
        "request_id": rid,
        "source_artifact_ref": source_artifact_ref(request),
        "source_fingerprint": source_fingerprint(request),
        "code": code,
        "message": message,
        "observed_at": observed_at(request),
    }
    if details:
        payload["details"] = details
    return record(f"package::audio-transcription::error::{address_token(rid, 'request')}", payload)


def float_or_default(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def word_records_from_command_output(value: Any) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    for item in list_or_empty(value):
        data = object_or_empty(item)
        token = data.get("t", data.get("word", data.get("text", "")))
        word: dict[str, Any] = {
            "t": str(token),
            "start": float_or_default(data.get("start")),
            "end": float_or_default(data.get("end")),
        }
        for key in ("confidence", "emphasis", "sentence_end", "hidden", "speaker", "timing_source"):
            if key in data:
                word[key] = data[key]
        if word["t"] or item:
            words.append(word)
    return words


def segment_records_from_command_output(value: Any) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for index, item in enumerate(list_or_empty(value)):
        data = object_or_empty(item)
        segment: dict[str, Any] = {
            "segment_index": int(data.get("segment_index", index)),
            "start": float_or_default(data.get("start")),
            "end": float_or_default(data.get("end")),
            "text": str(data.get("text", "")),
        }
        for key in ("speaker", "confidence"):
            if key in data:
                segment[key] = data[key]
        segments.append(segment)
    return segments


def canonical_records_from_command(request: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]]:
    provided_records = [item for item in list_or_empty(result.get("records")) if isinstance(item, dict)]
    if provided_records:
        records: list[dict[str, Any]] = []
        for item in provided_records:
            payload = object_or_empty(item.get("payload"))
            if not item.get("address") or not payload:
                continue
            if payload.get("kind") in ("audio-transcription.result", "audio-transcription.error"):
                payload.setdefault("source_artifact_ref", source_artifact_ref(request))
                payload.setdefault("source_fingerprint", source_fingerprint(request))
                if payload.get("kind") == "audio-transcription.result":
                    payload.setdefault("role", "results")
                elif payload.get("kind") == "audio-transcription.error":
                    payload.setdefault("role", "errors")
            records.append({
                "address": str(item.get("address")),
                "path": list_or_empty(item.get("path")) or PUBLISHED_PATH,
                "payload": payload,
            })
        return records

    text = result.get("full_text", result.get("text"))
    if not isinstance(text, str):
        return [
            error_record(
                request,
                "transcription_command_output_missing_full_text",
                "Transcription command output must contain string field full_text or text.",
                {"available_keys": sorted(str(key) for key in result.keys())},
            )
        ]

    rid = request_id(request)
    options = object_or_empty(request.get("options"))
    payload = {
        "kind": "audio-transcription.result",
        "role": "results",
        "request_id": rid,
        "source_artifact_ref": source_artifact_ref(request),
        "source_fingerprint": source_fingerprint(request),
        "command_run_id": result.get(
            "command_run_id",
            f"package::audio-transcription::command-run-request::{address_token(rid, 'request')}",
        ),
        "language": str(result.get("language") or options.get("language") or "und"),
        "full_text": text,
        "segments": segment_records_from_command_output(result.get("segments")),
        "words": word_records_from_command_output(result.get("words")),
        "output_artifact_refs": list_or_empty(result.get("output_artifact_refs")),
        "completed_at": str(result.get("completed_at") or observed_at(request) or ""),
    }
    return [record(f"package::audio-transcription::result::{address_token(rid, 'request')}", payload)]


def build_output(request: dict[str, Any], command_output: dict[str, Any]) -> dict[str, Any]:
    records = canonical_records_from_command(request, command_output)
    return {
        "kind": "audio-transcription.records-from-command-run",
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
            "kind": "audio-transcription.records-from-command-run",
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
