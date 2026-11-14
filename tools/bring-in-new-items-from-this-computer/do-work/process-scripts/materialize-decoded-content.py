#!/usr/bin/env python3
"""Turn trusted decoder output into bounded observed-content owner writes.

This process is intentionally transport- and provider-blind. Signature admission
and exactly-once claiming happen before it is called. It accepts only canonical
transcript-mapper atom identities and emits deterministic owner-addressed writes.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys


MAX_INPUT_BYTES = 25 * 1024 * 1024
MAX_ATOMS = 1_000
MAX_THREADS = 100
ATOM_REF = re.compile(r"^atom:1f:[0-9a-f]{64}$")


def _load(path: pathlib.Path) -> dict:
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("decoded content input exceeds 25 MiB")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("decoded content input must be an object")
    return value


def materialize(request: dict) -> dict:
    decoded = request.get("decoded")
    event_id = request.get("event_id")
    source_ref = request.get("source_ref")
    observed_at = request.get("observed_at")
    if not isinstance(decoded, dict):
        raise ValueError("decoded must be an object")
    if not isinstance(event_id, str) or not event_id.strip():
        raise ValueError("event_id must be non-empty text")
    if not isinstance(source_ref, str) or not source_ref.strip():
        raise ValueError("source_ref must be non-empty text")
    if observed_at is not None and not isinstance(observed_at, str):
        raise ValueError("observed_at must be text or null")

    rejections = decoded.get("rejections") or []
    threads = decoded.get("threads") or []
    atoms = decoded.get("atoms") or []
    if not all(isinstance(value, list) for value in (rejections, threads, atoms)):
        raise ValueError("decoded threads, atoms, and rejections must be arrays")
    if len(threads) > MAX_THREADS or len(atoms) > MAX_ATOMS:
        raise ValueError("decoded content exceeds bounded item counts")
    if rejections:
        return {
            "accepted": False,
            "reason": "decoder-rejected",
            "writes": [],
            "rejections": rejections,
        }

    thread_refs = {
        item.get("thread_ref")
        for item in threads
        if isinstance(item, dict) and isinstance(item.get("thread_ref"), str)
    }
    writes = []
    atom_refs = []
    for atom in atoms:
        if not isinstance(atom, dict):
            raise ValueError("every atom must be an object")
        atom_ref = atom.get("atom_ref")
        thread_ref = atom.get("thread_ref")
        if not isinstance(atom_ref, str) or not ATOM_REF.fullmatch(atom_ref):
            raise ValueError("atom_ref must be a canonical transcript-mapper identity")
        if not isinstance(thread_ref, str) or thread_ref not in thread_refs:
            raise ValueError("atom thread_ref must resolve to a decoded thread")
        if atom.get("source_ref") != source_ref:
            raise ValueError("atom source_ref must match the admitted source")
        atom_refs.append(atom_ref)
        payload = dict(atom)
        payload["atom_kind"] = payload.pop("kind", "utterance")
        payload["kind"] = "observed-content.content-atom"
        writes.append({
            "address": atom_ref,
            "address_mode": "identity_text",
            "path": ["current-item", "published-record"],
            "payload": payload,
            "remove": False,
        })

    receipt_suffix = hashlib.sha256(event_id.encode("utf-8")).hexdigest()
    writes.append({
        "address": f"package::observed-content::ingest-receipt::{receipt_suffix}",
        "address_mode": "identity_text",
        "path": ["current-item", "published-record"],
        "payload": {
            "kind": "observed-content.ingest-receipt",
            "event_id": event_id,
            "source_ref": source_ref,
            "observed_at": observed_at,
            "thread_refs": sorted(thread_refs),
            "atom_refs": atom_refs,
            "atom_count": len(atom_refs),
        },
        "remove": False,
    })
    return {"accepted": True, "writes": writes, "atom_refs": atom_refs}


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: materialize-decoded-content.py <request.json> <output.json>")
    result = materialize(_load(pathlib.Path(sys.argv[1])))
    pathlib.Path(sys.argv[2]).write_text(
        json.dumps(result, separators=(",", ":")), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
