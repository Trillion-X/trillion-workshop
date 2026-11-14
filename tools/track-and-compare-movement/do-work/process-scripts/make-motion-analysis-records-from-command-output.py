#!/usr/bin/env python3
"""Make motion analysis records from external command output."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


PUBLISHED_PATH = ["motion-analysis", "content-media-evidence"]
MOTION_KINDS = {
    "motion-analysis.track",
    "motion-analysis.phase",
    "motion-analysis.alignment",
    "motion-analysis.comparison",
    "motion-analysis.error",
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


def request_sources(request: dict[str, Any]) -> list[dict[str, Any]]:
    sources = [item for item in list_or_empty(request.get("sources")) if isinstance(item, dict)]
    if sources:
        return sources
    legacy_source = request.get("source")
    return [legacy_source] if isinstance(legacy_source, dict) else []


def source_index(item: dict[str, Any]) -> int:
    try:
        return int(item.get("source_index", 0))
    except (TypeError, ValueError):
        return 0


def source_for(request: dict[str, Any], item: dict[str, Any] | None = None) -> dict[str, Any]:
    sources = request_sources(request)
    if not sources:
        return {}
    index = source_index(object_or_empty(item))
    if index < 0 or index >= len(sources):
        index = 0
    return sources[index]


def source_artifact_ref(source: dict[str, Any]) -> dict[str, Any]:
    return object_or_empty(source.get("artifact_ref"))


def source_fingerprint_for_source(source: dict[str, Any]) -> str:
    ref = source_artifact_ref(source)
    for value in (
        source.get("source_fingerprint"),
        source.get("asset_id"),
        ref.get("multihash"),
        ref.get("cas_address"),
        ref.get("content_hash"),
        ref.get("sha256"),
    ):
        if value not in (None, ""):
            return str(value)
    return "unknown-source"


def source_ref(request: dict[str, Any], item: dict[str, Any] | None = None) -> dict[str, Any]:
    data = object_or_empty(item)
    explicit = object_or_empty(data.get("source_ref"))
    if explicit:
        return explicit
    source = source_for(request, data)
    if not source:
        return {}
    return {
        "source_index": source_index(data),
        "source_fingerprint": source_fingerprint_for_source(source),
        "artifact_ref": source_artifact_ref(source),
    }


def source_fingerprint(request: dict[str, Any], item: dict[str, Any] | None = None) -> str:
    data = object_or_empty(item)
    if data.get("source_fingerprint") not in (None, ""):
        return str(data.get("source_fingerprint"))
    return str(source_ref(request, data).get("source_fingerprint") or request_id(request))


def command_run_id(request: dict[str, Any], item: dict[str, Any] | None = None) -> str:
    data = object_or_empty(item)
    return str(data.get("command_run_id") or f"package::motion-analysis::command-run-request::{address_token(request_id(request), 'request')}")


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


def source_refs(request: dict[str, Any]) -> list[dict[str, Any]]:
    return [source_ref(request, {"source_index": index}) for index, _ in enumerate(request_sources(request))]


def error_record(
    request: dict[str, Any],
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rid = request_id(request)
    payload: dict[str, Any] = {
        "kind": "motion-analysis.error",
        "role": "errors",
        "request_id": rid,
        "sources": source_refs(request),
        "command_run_id": command_run_id(request),
        "code": code,
        "message": message,
        "observed_at": observed_at(request),
    }
    if details:
        payload["details"] = details
    return record(f"package::motion-analysis::error::{address_token(rid, 'request')}", payload)


def track_record(request: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    rid = request_id(request)
    track_id = str(item.get("track_id") or f"{rid}:track:{index}")
    payload = {
        "kind": "motion-analysis.track",
        "role": "tracks",
        "track_id": track_id,
        "request_id": rid,
        "source_ref": source_ref(request, item),
        "source_fingerprint": source_fingerprint(request, item),
        "command_run_id": command_run_id(request, item),
        "subject_ref": object_or_empty(item.get("subject_ref")),
        "keypoint_schema": object_or_empty(item.get("keypoint_schema")),
        "time_range": object_or_empty(item.get("time_range")),
        "sample_rate": item.get("sample_rate"),
        "track_artifact_ref": object_or_empty(item.get("track_artifact_ref") or item.get("artifact_ref")),
        "model": object_or_empty(item.get("model")),
        "evidence": item.get("evidence", {}),
        "created_at": str(item.get("created_at") or observed_at(request) or ""),
    }
    return record(f"package::motion-analysis::track::{address_token(track_id, f'track-{index}')}", payload)


def phase_record(request: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    rid = request_id(request)
    phase_id = str(item.get("phase_id") or f"{rid}:phase:{index}")
    track_ref = item.get("track_ref") or item.get("track_id")
    label = str(item.get("label") or item.get("phase_label") or "motion phase")
    payload = {
        "kind": "motion-analysis.phase",
        "role": "phases",
        "phase_id": phase_id,
        "request_id": rid,
        "source_ref": source_ref(request, item),
        "source_fingerprint": source_fingerprint(request, item),
        "command_run_id": command_run_id(request, item),
        "track_ref": ref_from(track_ref, "motion-analysis.track-ref", "track_id"),
        "label": label,
        "label_ref": object_or_empty(item.get("label_ref")),
        "time_range": object_or_empty(item.get("time_range")),
        "phase_taxonomy_ref": object_or_empty(item.get("phase_taxonomy_ref")),
        "evidence": item.get("evidence", {}),
        "created_at": str(item.get("created_at") or observed_at(request) or ""),
    }
    return record(f"package::motion-analysis::phase::{address_token(phase_id, f'phase-{index}')}", payload)


def alignment_record(request: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    rid = request_id(request)
    alignment_id = str(item.get("alignment_id") or f"{rid}:alignment:{index}")
    payload = {
        "kind": "motion-analysis.alignment",
        "role": "alignments",
        "alignment_id": alignment_id,
        "request_id": rid,
        "command_run_id": command_run_id(request, item),
        "source_span_refs": list_or_empty(item.get("source_span_refs")),
        "method": str(item.get("method") or "motion-alignment"),
        "score": float_or_default(item.get("score"), 0.0),
        "transform_artifact_ref": object_or_empty(item.get("transform_artifact_ref")),
        "evidence": item.get("evidence", {}),
        "created_at": str(item.get("created_at") or observed_at(request) or ""),
    }
    return record(f"package::motion-analysis::alignment::{address_token(alignment_id, f'alignment-{index}')}", payload)


def comparison_record(request: dict[str, Any], item: dict[str, Any], index: int) -> dict[str, Any]:
    rid = request_id(request)
    comparison_id = str(item.get("comparison_id") or f"{rid}:comparison:{index}")
    payload = {
        "kind": "motion-analysis.comparison",
        "role": "comparisons",
        "comparison_id": comparison_id,
        "request_id": rid,
        "command_run_id": command_run_id(request, item),
        "alignment_refs": list_or_empty(item.get("alignment_refs")),
        "summary": object_or_empty(item.get("summary")),
        "metrics": object_or_empty(item.get("metrics")),
        "evidence_refs": list_or_empty(item.get("evidence_refs")),
        "output_artifact_refs": list_or_empty(item.get("output_artifact_refs")),
        "created_at": str(item.get("created_at") or observed_at(request) or ""),
    }
    return record(f"package::motion-analysis::comparison::{address_token(comparison_id, f'comparison-{index}')}", payload)


def records_from_motion_clip_descriptor(request: dict[str, Any], desc: dict[str, Any]) -> list[dict[str, Any]]:
    """L098 translation boundary: a perception command that emits its NATIVE self-describing
    `motion-clip-descriptor.v1` (the crown-jewel describe_clip output: {schema, source, fps, frames,
    windows:[{t0,t1,...generic per-window measures...}]}) is mapped here into the package's canonical
    track + phase records. The perception engine stays pure (it never learns the package contract); this
    record-maker — the data owner — does ALL the translation. GENERIC (L090): one clip -> one track, one
    window -> one phase; every per-window field is carried through as phase evidence verbatim, NOTHING is
    enumerated (no stroke/state vocabulary in this code — window fields are DATA passed through)."""
    src = object_or_empty(desc.get("source"))
    fp = str(src.get("fingerprint") or source_fingerprint(request))
    fps = desc.get("fps")
    frames = desc.get("frames")
    duration = (float(frames) / float(fps)) if (fps not in (None, "", 0) and frames not in (None, "")) else None
    windows = [w for w in list_or_empty(desc.get("windows")) if isinstance(w, dict)]

    # ONE track for the posed clip. time_range/sample_rate are clip-level; the descriptor's clip-wide
    # facts (schema, fps, frames, salience effector) ride in evidence so no fact is dropped.
    track_item = {
        "track_id": f"{address_token(fp, 'clip')}:track",
        "source_fingerprint": fp,
        "time_range": {"start": 0.0, "end": duration} if duration is not None else {},
        "sample_rate": fps,
        "evidence": {
            "schema": desc.get("schema"),
            "fps": fps,
            "frames": frames,
            "salience_fp": desc.get("salience_fp"),
            "source_path": src.get("path"),
            "window_count": len(windows),
        },
    }
    records: list[dict[str, Any]] = [track_record(request, track_item, 0)]

    for index, w in enumerate(windows):
        # Carry EVERY window field through as evidence except the time bounds (which become time_range) —
        # completeness over selectivity, zero enumeration. The engine is deliberately LABEL-FREE (it emits
        # continuous measures, not a stroke/phase vocabulary), so `state` is a measure DICT that stays in
        # evidence; the phase label is purely POSITIONAL (never a Society stroke name in this code).
        evidence = {k: v for k, v in w.items() if k not in ("t0", "t1")}
        phase_item = {
            "phase_id": f"{address_token(fp, 'clip')}:phase:{index}",
            "track_ref": track_item["track_id"],
            "source_fingerprint": fp,
            "label": f"motion window {index + 1}",
            "time_range": {"start": w.get("t0"), "end": w.get("t1")},
            "evidence": evidence,
        }
        records.append(phase_record(request, phase_item, index))
    return records


def normalize_provided_records(request: dict[str, Any], provided_records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for item in provided_records:
        payload = object_or_empty(item.get("payload"))
        if not item.get("address") or not payload:
            continue
        if payload.get("kind") in MOTION_KINDS:
            payload.setdefault("request_id", request_id(request))
            payload.setdefault("command_run_id", command_run_id(request, payload))
            if payload.get("kind") in {"motion-analysis.track", "motion-analysis.phase"}:
                payload.setdefault("source_ref", source_ref(request, payload))
                payload.setdefault("source_fingerprint", source_fingerprint(request, payload))
            if payload.get("kind") == "motion-analysis.error":
                payload.setdefault("sources", source_refs(request))
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

    # Self-describing dispatch (L090): a perception command emitting its native motion-clip-descriptor
    # is translated to track+phase records here (the data-owner boundary, L098).
    if result.get("schema") == "motion-clip-descriptor.v1" or isinstance(result.get("windows"), list):
        descriptor_records = records_from_motion_clip_descriptor(request, result)
        if descriptor_records:
            return descriptor_records

    records: list[dict[str, Any]] = []
    for index, item in enumerate(item for item in list_or_empty(result.get("tracks")) if isinstance(item, dict)):
        records.append(track_record(request, item, index))
    for index, item in enumerate(item for item in list_or_empty(result.get("phases")) if isinstance(item, dict)):
        records.append(phase_record(request, item, index))
    for index, item in enumerate(item for item in list_or_empty(result.get("alignments")) if isinstance(item, dict)):
        records.append(alignment_record(request, item, index))
    for index, item in enumerate(item for item in list_or_empty(result.get("comparisons")) if isinstance(item, dict)):
        records.append(comparison_record(request, item, index))

    if records:
        return records

    return [
        error_record(
            request,
            "no_records_emitted",
            "Motion analysis command output did not contain tracks, phases, alignments, comparisons, or canonical records.",
            {"available_keys": sorted(str(key) for key in result.keys())},
        )
    ]


def build_output(request: dict[str, Any], command_output: dict[str, Any]) -> dict[str, Any]:
    records = canonical_records_from_command(request, command_output)
    return {
        "kind": "motion-analysis.records-from-command-run",
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
            "kind": "motion-analysis.records-from-command-run",
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
