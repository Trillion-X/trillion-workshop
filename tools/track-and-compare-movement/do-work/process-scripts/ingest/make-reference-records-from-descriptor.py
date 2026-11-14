#!/usr/bin/env python3
"""Make reference-clip records from a motion clip descriptor."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


PUBLISHED_PATH = ["motion-analysis", "content-media-evidence"]


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


def address_token(value: Any, fallback: str) -> str:
    raw = str(value) if value not in (None, "") else fallback
    return "".join(ch if ch.isalnum() or ch in "._:-" else "_" for ch in raw)


def required_text(value: Any, name: str) -> str:
    if value in (None, ""):
        raise ValueError(f"{name} is required")
    return str(value)


def require_descriptor(descriptor: Any) -> dict[str, Any]:
    if not isinstance(descriptor, dict):
        raise ValueError("descriptor must be an object")
    if descriptor.get("schema") != "motion-clip-descriptor.v1":
        raise ValueError("descriptor schema must be motion-clip-descriptor.v1")
    windows = descriptor.get("windows")
    if not isinstance(windows, list):
        raise ValueError("descriptor windows must be a list")
    for index, item in enumerate(windows):
        if not isinstance(item, dict):
            raise ValueError(f"descriptor windows[{index}] must be an object")
    return descriptor


def record(address: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"address": address, "path": PUBLISHED_PATH, "payload": payload}


def reference_records_from_descriptor(request: dict[str, Any], descriptor: dict[str, Any]) -> list[dict[str, Any]]:
    """Translate one self-describing motion descriptor into one reference-clip record.

    GENERIC (L090): this dispatches only on the descriptor schema and carries the descriptor's
    per-window DATA verbatim. HONEST (L117): no derived reference values are invented; absent
    optional descriptor fields stay absent/null, while required request addresses fail closed.
    """
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    desc = require_descriptor(descriptor)

    reference_clip_id = required_text(request.get("reference_clip_id"), "reference_clip_id")
    payload = {
        "kind": "motion-reference-clip",
        "role": "reference-clips",
        "reference_clip_id": reference_clip_id,
        "clip_cas": required_text(request.get("clip_cas"), "clip_cas"),
        "kp_cas": required_text(request.get("kp_cas"), "kp_cas"),
        "fps": desc.get("fps"),
        "frames": desc.get("frames"),
        "windows": list(desc["windows"]),
        "created_at": required_text(request.get("created_at"), "created_at"),
        "descriptor_schema": desc.get("schema"),
    }
    return [record(f"package::motion-analysis::reference-clip::{address_token(reference_clip_id, 'reference')}", payload)]


def build_output(request: dict[str, Any], descriptor: dict[str, Any]) -> dict[str, Any]:
    records = reference_records_from_descriptor(request, descriptor)
    return {
        "kind": "motion-analysis.reference-records-from-descriptor",
        "reference_clip_id": request.get("reference_clip_id"),
        "records": records,
        "summary": {
            "record_count": len(records),
            "descriptor_supplied": True,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-json", required=True)
    parser.add_argument("--descriptor-json", required=True)
    parser.add_argument("--output-json", required=True)
    # Engine-CAS provenance addresses, supplied by the live workflow as DATA bindings (clip_cas = the
    # clip blob_ref hash the caller staged; kp_cas = the perception kp output's engine content_hash).
    # Only the engine can mint these (1f:<content-hash> CAS addresses), so they arrive as args, not in
    # the static request record; when present they override the request fields. Offline callers may
    # still put clip_cas/kp_cas directly in the request (back-compat).
    parser.add_argument("--clip-cas", default=None)
    parser.add_argument("--kp-cas", default=None)
    args = parser.parse_args()

    request = read_json(args.request_json)
    descriptor = read_json(args.descriptor_json)
    if args.clip_cas not in (None, ""):
        request["clip_cas"] = args.clip_cas
    if args.kp_cas not in (None, ""):
        request["kp_cas"] = args.kp_cas
    write_json(args.output_json, build_output(request, descriptor))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
