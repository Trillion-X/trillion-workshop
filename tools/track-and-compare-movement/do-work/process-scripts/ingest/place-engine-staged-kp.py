#!/usr/bin/env python3
"""Adapter (L098): translate the engine's flat blob_ref kp mounts to the materializer's kp-path contract.

The live workflow mounts each motion-reference-clip record's keypoint blob (via a compute.process
`{kind:"blob_ref",hash:kp_cas}` input) at a FLAT, mount-order path `<staged-dir>/<i>.kp.json` — because a
workflow-def's mount paths are STATIC and cannot be templated from the record's `clip_cas` at runtime. This
generic placer reads `records.json`, and for each record `i` copies `<staged-dir>/<i>.kp.json` to the exact
path the materializer's `--engine-staged` mode fail-closed verifies: `<out-dir>/_work/<_safe_key(clip_cas)>.kp.json`.

It owns the engine-flat -> key-path translation so `materialize-index-from-reference-records.py` keeps a pure
`_work/<key>.kp.json` contract (it never learns the engine's mount-ordering). Works for ANY number of records;
the only thing that grows with N is the count of static blob_ref mounts in the workflow-def (the dynamic-N-mount
engine seam), never this logic. FAIL-CLOSED: a missing staged blob or absent clip_cas raises before any copy.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
from pathlib import Path
from typing import Any

# Load the materializer's SSOT helpers by file path (the module name is hyphenated, so not importable by name).
# Reusing _safe_key/_payload_of/_require guarantees the placer's kp path can never diverge from the path the
# materializer verifies — one key function, two consumers.
_MAT_PATH = Path(__file__).resolve().parent / "materialize-index-from-reference-records.py"
_spec = importlib.util.spec_from_file_location("_materializer", _MAT_PATH)
_mat = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader, f"cannot load materializer module at {_MAT_PATH}"
_spec.loader.exec_module(_mat)  # type: ignore[union-attr]


def _records(value: Any) -> list[Any]:
    if isinstance(value, dict) and isinstance(value.get("records"), list):
        return value["records"]
    if isinstance(value, list):
        return value
    raise ValueError("--records-json must be a records array or a {records:[...]} object")


def place(records_json: str, staged_dir: str, out_dir: str) -> dict[str, Any]:
    with open(records_json, "r", encoding="utf-8") as handle:
        records = _records(json.load(handle))
    staged = Path(staged_dir)
    work = Path(out_dir) / "_work"
    work.mkdir(parents=True, exist_ok=True)
    placed: list[str] = []
    for index, record in enumerate(records):
        payload = _mat._payload_of(record)
        clip_cas = _mat._require(payload, "clip_cas")
        key = _mat._safe_key(str(clip_cas))
        src = staged / f"{index}.kp.json"
        if not src.is_file():
            raise SystemExit(
                f"engine-staged kp blob missing for record {index} at {src} "
                f"(expected a compute.process blob_ref input for kp_cas of clip_cas {clip_cas!r})"
            )
        shutil.copyfile(src, work / f"{key}.kp.json")
        placed.append(key)
    return {"placed": len(placed), "keys": placed}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records-json", required=True)
    parser.add_argument("--staged-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    print(json.dumps(place(args.records_json, args.staged_dir, args.out_dir), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
