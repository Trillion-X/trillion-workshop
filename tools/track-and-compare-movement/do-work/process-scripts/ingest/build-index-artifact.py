"""build-index-artifact.py — turnkey bootstrap: reference-clip records -> ONE content-addressed index .tar.

This is the OFFLINE bootstrap builder the live phase calls to produce the index artifact that the
motion-comparison match step mounts via blob_ref (source {kind:"blob_ref", hash:<sha256 printed here>}) and
orchestrate.sh untars. It is the proven shape: descriptors + kp materialized into a matcher-ready dir (via the
materialize bridge), then packed into a single tar — mounted as ONE blob (proven primitive), no per-entry
dynamic mount list needed. See [[reference_compute_process_blob_ref_mount_shape]].

  reference-clip records (+ kp resolver)  -> materialize_index (matcher-ready dir)  -> tar  -> {out-tar, sha256, size}

SIZING NOTE: descriptors are tiny (~290KB for the 8-clip oracle corpus); kp is the bulk (~613M). The full tar is
correctness-simple and uses only the proven single-blob mount. A leaner descriptors-only artifact + per-candidate
kp via blob_ref (kp is read lazily per gated candidate) is the perf refinement to measure on a live engine — it
needs the unverified dynamic per-candidate mount, so it is NOT used here. Correctness first; the full tar works today.

USAGE:
  python3 build-index-artifact.py --records-json REFS.json --kp-source-dir KPDIR --out-tar index.tar
    REFS.json = {"records":[<motion-reference-clip record>, ...]} or a bare [ ... ] list.
    --kp-source-dir = a dir of <kp_cas>.kp.json (offline resolver). Omit + use --engine-staged when the engine
       pre-mounts kp via blob_ref (live).
  Prints: entries=<n> sha256=<hex> bytes=<n>   (the sha256 is the blob hash to put in reference_index_ref.hash)
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


BRIDGE = _load(HERE / "materialize-index-from-reference-records.py", "materialize_bridge")


def _records(records_json: str) -> list[dict]:
    doc = json.loads(Path(records_json).read_text())
    recs = doc.get("records") if isinstance(doc, dict) else doc
    if not isinstance(recs, list) or not recs:
        raise ValueError(f"--records-json must contain a non-empty list (or {{records:[...]}}); got {type(recs).__name__}")
    return recs


def build_index_artifact(
    records: list[dict], *, kp_source_dir: str | None, out_tar: str, index_dir: str | None = None
) -> dict:
    """Materialize the records into a matcher-ready dir and pack it into ONE tar at out_tar. Returns
    {entries, keys, sha256, bytes}. sha256 is the artifact blob hash (-> reference_index_ref.hash).

    Two kp modes via the materialize bridge's `kp_resolver` seam (L089), ONE canonical deterministic packer:
      * RESOLVER (offline): `kp_source_dir` set -> bridge resolves kp bytes from the dir into a fresh tempdir.
      * ENGINE-STAGED (live): `index_dir` set + `kp_source_dir` None -> kp blobs are ALREADY placed in
        `index_dir/_work/<key>.kp.json` (by the live `materialize-index` action's placer); the bridge writes
        descriptors and fail-closed verifies kp presence in `index_dir`, then we pack `index_dir`.
    Using `index_dir` (not a tempdir) lets the engine's blob_ref mounts + the placer prepopulate kp; the SAME
    `pack_index_dir` produces the SAME deterministic tar bytes the offline path produces (SSOT, CAS dedup)."""
    resolver = BRIDGE._dir_kp_resolver(kp_source_dir) if kp_source_dir else None
    if index_dir is not None:
        summary = BRIDGE.materialize_index(records, kp_resolver=resolver, out_dir=index_dir)
        packed = pack_index_dir(index_dir, out_tar)
        return {"entries": summary["count"], "keys": summary["keys"], **packed}
    with tempfile.TemporaryDirectory() as built:
        summary = BRIDGE.materialize_index(records, kp_resolver=resolver, out_dir=built)
        packed = pack_index_dir(built, out_tar)
        return {"entries": summary["count"], "keys": summary["keys"], **packed}


def pack_index_dir(src_dir: str, out_tar: str) -> dict:
    """Pack a materialized matcher-ready index dir into ONE DETERMINISTIC tar — the SINGLE canonical packer
    (used by build_index_artifact AND the roundtrip proof; no second divergent impl). Returns {sha256, bytes}.

    Deterministic: same index dir -> same tar bytes -> same sha256 (CAS dedup). Files only, recursive=False —
    adding a dir entry would recurse AND rglob re-adds each file, duplicating every kp (2x bloat); extractall
    recreates parent dirs from the file arcnames."""
    def _deterministic(ti: tarfile.TarInfo) -> tarfile.TarInfo:
        ti.mtime = 0
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = ""
        return ti

    out = Path(out_tar)
    out.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(out, "w") as tf:
        for p in sorted(Path(src_dir).rglob("*")):
            if p.is_file():
                tf.add(p, arcname=str(p.relative_to(src_dir)), recursive=False, filter=_deterministic)
    data = out.read_bytes()
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records-json", required=True, help="reference-clip records: {records:[...]} or [...]")
    ap.add_argument("--kp-source-dir", default=None, help="RESOLVER mode (offline): dir of <kp_cas>.kp.json")
    ap.add_argument("--engine-staged", action="store_true", help="ENGINE-STAGED mode (live): kp pre-placed in --index-dir/_work by the placer")
    ap.add_argument("--index-dir", default=None, help="ENGINE-STAGED only: the matcher-ready index dir whose _work holds the placed kp")
    ap.add_argument("--out-tar", required=True, help="write the index .tar artifact here")
    args = ap.parse_args()
    # exactly one mode: resolver (kp-source-dir) XOR engine-staged (index-dir)
    if args.engine_staged == bool(args.kp_source_dir):
        raise SystemExit("provide exactly one of --kp-source-dir (offline resolver) or --engine-staged (live)")
    if args.engine_staged and not args.index_dir:
        raise SystemExit("--engine-staged requires --index-dir (the placer-populated matcher-ready dir)")
    res = build_index_artifact(
        _records(args.records_json),
        kp_source_dir=args.kp_source_dir,
        out_tar=args.out_tar,
        index_dir=args.index_dir if args.engine_staged else None,
    )
    print(f"entries={res['entries']} sha256={res['sha256']} bytes={res['bytes']} out={args.out_tar}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
