#!/usr/bin/env python3
"""Make a `motion-reference-index` DISCOVERY record from a built index's CAS hash + its reference records.

WHY THIS EXISTS (the index-discovery gap): `motion-comparison.run-comparison` receives `reference_index_ref`
as a raw `{ hash }` — so the CALLER must already know the index's CAS hash. There is no record a live
consumer can READ to find "the current reference index." This producer makes that record: given the index
artifact's CAS multihash (the single blob_ref-mountable address a consumer passes as `reference_index_ref.hash`)
and the reference-clip records the index was built from, it emits one self-describing `motion-reference-index`
record. A live consumer reads this record, takes `index_ref_hash`, and dispatches run-comparison — decoupled
from knowing the hash (L098: the consumer is served in its own language, not the index's internals).

GENERIC (L090): dispatches only on the index-record schema; carries the index hash + the clip ids verbatim.
HONEST (L117): invents no derived values — absent optional fields stay absent; required addresses fail closed.
The index hash is an engine-minted CAS address (only the publish step that staged the index blob can mint it),
so it arrives as `--index-ref-hash`, mirroring how clip_cas/kp_cas arrive in make-reference-records-from-descriptor.py.
Run: python3 make-reference-index-record.py --index-ref-hash <1f:...> --reference-records-json R --output-json O --created-at T
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


PUBLISHED_PATH = ["motion-analysis", "reference-index"]
SCHEMA = "motion-reference-index.v1"


def read_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


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


def _records_list(reference_records: Any) -> list[dict[str, Any]]:
    """Accept either {records:[...]} or a bare [...] of reference-clip records; fail closed otherwise."""
    seq = reference_records.get("records") if isinstance(reference_records, dict) else reference_records
    if not isinstance(seq, list):
        raise ValueError("reference_records must be a list (or {records:[...]}) of reference-clip records")
    return seq


def reference_clip_ids(reference_records: Any) -> list[str]:
    """Extract each reference-clip's id, in order, from the records the index was built from.

    Reads `payload.reference_clip_id` (falling back to `payload.clip_cas`) — the same identity the
    materializer keys the index by. Fail-closed if a record carries neither.
    """
    ids: list[str] = []
    for index, item in enumerate(_records_list(reference_records)):
        payload = item.get("payload") if isinstance(item, dict) else None
        if not isinstance(payload, dict):
            raise ValueError(f"reference_records[{index}] has no payload object")
        clip_id = payload.get("reference_clip_id") or payload.get("clip_cas")
        if clip_id in (None, ""):
            raise ValueError(f"reference_records[{index}] has no reference_clip_id or clip_cas")
        ids.append(str(clip_id))
    return ids


def record(address: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"address": address, "path": PUBLISHED_PATH, "payload": payload}


def reference_index_record(
    *,
    index_ref_hash: Any,
    reference_records: Any,
    created_at: Any,
    index_id: Any = None,
    comparison_spec_ref: Any = None,
    index_byte_len: Any = None,
) -> dict[str, Any]:
    """One self-describing `motion-reference-index` discovery record for a published index artifact."""
    idx_hash = required_text(index_ref_hash, "index_ref_hash")
    clip_ids = reference_clip_ids(reference_records)
    resolved_id = index_id if index_id not in (None, "") else idx_hash
    payload: dict[str, Any] = {
        "kind": "motion-reference-index",
        "role": "reference-index",
        "schema": SCHEMA,
        "index_ref_hash": idx_hash,
        "reference_clip_ids": clip_ids,
        "reference_count": len(clip_ids),
        "created_at": required_text(created_at, "created_at"),
    }
    # Optional, honest: present only when supplied (no invented defaults).
    if comparison_spec_ref not in (None, ""):
        payload["comparison_spec_ref"] = str(comparison_spec_ref)
    if index_byte_len not in (None, ""):
        payload["index_byte_len"] = int(index_byte_len)
    return record(
        f"package::motion-analysis::reference-index::{address_token(resolved_id, 'reference-index')}",
        payload,
    )


def build_output(args_like: dict[str, Any]) -> dict[str, Any]:
    rec = reference_index_record(
        index_ref_hash=args_like.get("index_ref_hash"),
        reference_records=args_like.get("reference_records"),
        created_at=args_like.get("created_at"),
        index_id=args_like.get("index_id"),
        comparison_spec_ref=args_like.get("comparison_spec_ref"),
        index_byte_len=args_like.get("index_byte_len"),
    )
    return {
        "kind": "motion-analysis.reference-index-record",
        "index_ref_hash": rec["payload"]["index_ref_hash"],
        "records": [rec],
        "summary": {"record_count": 1, "reference_count": rec["payload"]["reference_count"]},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-records-json", required=True, help="the reference-clip records the index was built from ({records:[...]} or [...])")
    parser.add_argument("--output-json", required=True)
    # --input-json supplies the scalar/optional fields as ONE object (the workflow-dispatch shape). The live
    # `publish-reference-index` action mounts the whole dispatch input as this file, so the engine never binds
    # an ABSENT optional input into a separate argv slot (which becomes a literal `null` ->
    # FE_CODEC_ERROR "invalid type: null, expected a string"). See memory
    # reference_workflow_absent_optional_input_arg_null_codec_error. Explicit flags (offline/tests) still win.
    parser.add_argument("--input-json", default=None, help="JSON file with {index_ref_hash, created_at, index_id?, comparison_spec_ref?, index_byte_len?} (workflow-dispatch shape)")
    parser.add_argument("--index-ref-hash", default=None, help="CAS multihash of the published index.tar blob (the reference_index_ref.hash a consumer mounts)")
    parser.add_argument("--created-at", default=None)
    parser.add_argument("--index-id", default=None, help="optional stable id for the index record address (defaults to the index hash)")
    parser.add_argument("--comparison-spec-ref", default=None)
    parser.add_argument("--index-byte-len", default=None)
    args = parser.parse_args()

    base = read_json(args.input_json) if args.input_json else {}
    if not isinstance(base, dict):
        raise ValueError("--input-json must contain a JSON object")

    def pick(flag_value: Any, key: str) -> Any:
        """Explicit flag wins when supplied; otherwise fall back to the dispatch object (absent stays absent)."""
        return flag_value if flag_value not in (None, "") else base.get(key)

    write_json(
        args.output_json,
        build_output(
            {
                "index_ref_hash": pick(args.index_ref_hash, "index_ref_hash"),
                "reference_records": read_json(args.reference_records_json),
                "created_at": pick(args.created_at, "created_at"),
                "index_id": pick(args.index_id, "index_id"),
                "comparison_spec_ref": pick(args.comparison_spec_ref, "comparison_spec_ref"),
                "index_byte_len": pick(args.index_byte_len, "index_byte_len"),
            }
        ),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
