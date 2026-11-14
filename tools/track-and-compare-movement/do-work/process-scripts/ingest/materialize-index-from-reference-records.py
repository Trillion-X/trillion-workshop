#!/usr/bin/env python3
"""Materialize a matcher-readable descriptor INDEX directory from motion-reference-clip records.

This is the INVERSE of make-reference-records-from-descriptor.py and the records->index BRIDGE of the
crown-jewel motion port:

    perception -> motion-clip-descriptor.v1 -> (ingest record-maker) -> motion-reference-clip RECORDS
                                                                              |
                                                        THIS MODULE (materialize) |
                                                                              v
                            index dir  <key>.desc.json + _work/<key>.kp.json  -> select_partner.get_index

ARCHITECTURE (why a projection, not a matcher change):
  * The motion-reference-clip RECORDS are the package SSOT (the ingest output / log records).
  * The certified matcher (`select_partner` + `viewpoint_index.get_index`) reads a DESCRIPTOR-DIR index:
    one `<key>.desc.json` per clip (schema/source/fps/frames/windows) plus `_work/<key>.kp.json` keypoints.
  * The matcher core is FROZEN (S1 0-wrong safety). So the index is a DERIVED PROJECTION of the records,
    materialized by this pure transform — NOT a second hand-maintained source, and NOT a matcher edit
    (L030: don't touch the frozen core; records stay the single source of truth).

GENERIC (L090): dispatches only on `kind == "motion-reference-clip"`; carries each record's `windows`
verbatim; no domain literal anywhere. FAIL-CLOSED (L117): a wrong-kind record, a missing required field,
or a resolver that cannot produce keypoint bytes RAISES — a partial/own-key-colliding index is never
written silently.

THE CAS SEAM (L089 — environment is DATA, not a code branch): a record carries `kp_cas` (a content-address
ref), NOT keypoint bytes. The keypoint bytes are produced by an INJECTED `kp_resolver(kp_cas) -> bytes|str`.
The SAME transform serves both worlds — offline the resolver reads a local CAS/file dir; live the resolver
is the engine CAS. This module never resolves CAS itself and never imports the matcher.

Reconstructed descriptor (exactly the fields `select_partner`/`viewpoint_index` read):
    {schema, source:{path: reference_clip_id, fingerprint: clip_cas}, fps, frames, windows}
  - `source.path`    -> the partner clip path the matcher returns as `partner_clip`.
  - `source.fingerprint` (= clip_cas, the FULL content hash) -> the matcher's content self-exclusion key.
  - `key` (the shared `<key>.desc.json` / `_work/<key>.kp.json` stem) -> a filesystem-safe token from clip_cas.

USAGE (offline CLI, dir-based resolver):
    materialize-index-from-reference-records.py \
        --records-json INGEST_OUTPUT.json   # the ingest record-maker output (or a bare records array) \
        --kp-source-dir DIR                 # holds keypoint bytes named <kp_cas> or <kp_cas>.kp.json/.json \
        --out-dir INDEX_DIR
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Callable, Iterable


REFERENCE_KIND = "motion-reference-clip"
DEFAULT_DESCRIPTOR_SCHEMA = "motion-clip-descriptor.v1"

# kp_resolver: given a record's kp_cas, return the keypoint-file CONTENTS (bytes or str). Raise / return
# None to signal "cannot resolve" (the caller fails closed). This is the only environment-specific seam.
KpResolver = Callable[[str], "bytes | str | None"]


def _safe_key(value: str) -> str:
    """A filesystem-safe stem shared by `<key>.desc.json` and `_work/<key>.kp.json`. Derived from the FULL
    clip_cas so the desc and kp files always pair, and so two distinct clips never collide on one key."""
    token = "".join(ch if (ch.isalnum() or ch in "._-") else "_" for ch in str(value))
    if not token:
        raise ValueError("clip_cas produced an empty index key")
    return token


def _payload_of(record: Any) -> dict[str, Any]:
    """Accept either a canonical record ({address, path, payload}) or a bare payload dict."""
    if not isinstance(record, dict):
        raise ValueError("each record must be an object")
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else record
    if not isinstance(payload, dict):
        raise ValueError("record payload must be an object")
    return payload


def _require(payload: dict[str, Any], name: str) -> Any:
    value = payload.get(name)
    if value in (None, ""):
        raise ValueError(f"motion-reference-clip record is missing required field {name!r}")
    return value


def descriptor_from_record(payload: dict[str, Any]) -> dict[str, Any]:
    """Reconstruct the exact descriptor shape `viewpoint_index.get_index` + `select_partner` read."""
    if payload.get("kind") != REFERENCE_KIND:
        raise ValueError(f"expected kind {REFERENCE_KIND!r}, got {payload.get('kind')!r}")
    windows = payload.get("windows")
    if not isinstance(windows, list):
        raise ValueError("motion-reference-clip record windows must be a list")
    reference_clip_id = _require(payload, "reference_clip_id")
    clip_cas = _require(payload, "clip_cas")
    return {
        "schema": payload.get("descriptor_schema") or DEFAULT_DESCRIPTOR_SCHEMA,
        # source.path = the clip the matcher returns as partner_clip; source.fingerprint = content
        # self-exclusion key (the FULL clip_cas), matching select_partner's source.fingerprint check.
        "source": {"path": str(reference_clip_id), "fingerprint": str(clip_cas)},
        "fps": payload.get("fps"),
        "frames": payload.get("frames"),
        "windows": list(windows),
    }


def materialize_index(
    records: Iterable[Any],
    *,
    kp_resolver: KpResolver | None,
    out_dir: str,
    encoding: str = "utf-8",
) -> dict[str, Any]:
    """Write a matcher-readable index dir from motion-reference-clip records. Returns a summary.

    For each record: write `<key>.desc.json` (reconstructed descriptor) and ensure `_work/<key>.kp.json`
    (keypoints) is present. TWO deployment modes via the `kp_resolver` seam (L089), one transform:

      * RESOLVER mode (`kp_resolver` callable) — offline/local: resolve `kp_resolver(kp_cas)` to bytes
        and WRITE `_work/<key>.kp.json`.
      * ENGINE-STAGED mode (`kp_resolver is None`) — live workflow: the engine has already mounted the
        keypoint blob at `_work/<key>.kp.json` via a `compute.process` input `{kind:"blob_ref",hash:kp_cas}`
        (ProcessInputSource::BlobRef → Envelope CAS). The script then only writes the descriptor and
        FAIL-CLOSED VERIFIES the kp file is present — it never invents keypoints.

    FAIL-CLOSED: wrong-kind / missing-field / unresolved-or-missing kp / duplicate clip_cas key all raise
    before a partial index is left behind on a key.
    """
    out = Path(out_dir)
    work = out / "_work"
    out.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)

    keys: list[str] = []
    seen: set[str] = set()
    for record in records:
        payload = _payload_of(record)
        descriptor = descriptor_from_record(payload)
        clip_cas = descriptor["source"]["fingerprint"]
        kp_cas = _require(payload, "kp_cas")
        key = _safe_key(clip_cas)
        if key in seen:
            raise ValueError(f"duplicate index key {key!r} (two records share clip_cas {clip_cas!r})")
        kp_path = work / f"{key}.kp.json"

        if kp_resolver is None:
            # ENGINE-STAGED: the blob_ref mount must already have placed the keypoints here.
            if not kp_path.is_file():
                raise ValueError(
                    f"engine-staged mode: keypoints not mounted at {kp_path} for kp_cas {kp_cas!r} "
                    "(expected a compute.process blob_ref input). Refusing to write a kp-less index entry."
                )
        else:
            kp_bytes = kp_resolver(str(kp_cas))
            if kp_bytes in (None, b"", ""):
                raise ValueError(f"kp_resolver produced no keypoints for kp_cas {kp_cas!r}")
            kp_text = kp_bytes.decode(encoding) if isinstance(kp_bytes, bytes) else str(kp_bytes)
            kp_path.write_text(kp_text, encoding=encoding)

        (out / f"{key}.desc.json").write_text(
            json.dumps(descriptor, ensure_ascii=False, separators=(",", ":")), encoding=encoding
        )
        seen.add(key)
        keys.append(key)

    return {"out_dir": str(out), "count": len(keys), "keys": keys}


def _records_from_input(value: Any) -> list[Any]:
    """Accept the ingest record-maker output ({records:[...]}) or a bare records array."""
    if isinstance(value, dict) and isinstance(value.get("records"), list):
        return value["records"]
    if isinstance(value, list):
        return value
    raise ValueError("--records-json must be a records array or a {records:[...]} object")


def _dir_kp_resolver(kp_source_dir: str) -> KpResolver:
    """Offline file-dir resolver: kp_cas -> bytes of <dir>/<kp_cas>[.kp.json|.json|''] (first that exists)."""
    base = Path(kp_source_dir)

    def resolve(kp_cas: str) -> bytes | None:
        for name in (kp_cas, f"{kp_cas}.kp.json", f"{kp_cas}.json"):
            candidate = base / name
            if candidate.is_file():
                return candidate.read_bytes()
        return None

    return resolve


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records-json", required=True)
    parser.add_argument(
        "--kp-source-dir",
        help="RESOLVER mode (offline): dir holding keypoints named <kp_cas>[.kp.json|.json]. "
        "Omit with --engine-staged when the engine has already mounted kp blobs into <out-dir>/_work.",
    )
    parser.add_argument(
        "--engine-staged",
        action="store_true",
        help="ENGINE-STAGED mode (live workflow): keypoints are pre-mounted at <out-dir>/_work/<key>.kp.json "
        "by compute.process blob_ref inputs; write descriptors only and fail-closed verify kp presence.",
    )
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    if args.engine_staged == bool(args.kp_source_dir):
        raise SystemExit("provide exactly one of --kp-source-dir (resolver) or --engine-staged")

    with open(args.records_json, "r", encoding="utf-8") as handle:
        records = _records_from_input(json.load(handle))
    resolver = None if args.engine_staged else _dir_kp_resolver(args.kp_source_dir)
    summary = materialize_index(records, kp_resolver=resolver, out_dir=args.out_dir)
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
