"""REAL-DATA proof: the ingest->records->index chain reproduces a real reference index, ref-count-faithfully.

Strongest offline proof of the records->index bridge (materialize-index-from-reference-records.py): it runs
the full chain on the REAL show-up-video-tennis `index_jib` reference set (not synthetic fixtures) and asserts
the FROZEN matcher loader (`viewpoint_index.get_index`) indexes the SAME number of refs from the
materialized portable index as from the original — with content-addressed keys (no `/`-bearing path leak).

  real index_jib/*.desc.json  -> reference_records_from_descriptor  -> motion-reference-clip records
                              -> materialize_index (offline file-dir resolver over the real _work kp)
                              -> viewpoint_index.get_index(materialized)  ==  get_index(original)   (ref count)

ENV NOTE: needs the real index_jib + the show-up-video-tennis tools/match dir (both env-specific) and numpy +
sklearn (no torch). If any is absent this SKIPS honestly (exit 0, prints SKIP) — it never falsely passes.

Run: python3 proof_realdata_index.py   ->   exit 0 = PASS or honest SKIP; exit 1 = FAIL.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ING = Path(__file__).resolve().parent
# The matcher lives in a sibling checkout beside this repository, so resolve it from
# this file rather than from one machine's home directory. ING.parents[4] is the repo root.
MATCH_DIR = ING.parents[4].parent / "show-up-video-tennis" / "tools" / "match"
IDX = MATCH_DIR / "index_jib"


def _load(p: Path, n: str):
    spec = importlib.util.spec_from_file_location(n, p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    if not IDX.is_dir() or not MATCH_DIR.is_dir():
        print(f"SKIP: real index_jib or tools/match absent ({IDX}) — env-specific proof not runnable here")
        return 0

    bridge = _load(ING / "materialize-index-from-reference-records.py", "mb")
    recmaker = _load(ING / "make-reference-records-from-descriptor.py", "recmk")
    sys.path.insert(0, str(MATCH_DIR))
    try:
        import viewpoint_index as VI  # numpy + sklearn BallTree, no torch
    except Exception as exc:  # noqa: BLE001
        print(f"SKIP: viewpoint_index import failed ({type(exc).__name__}: {exc})")
        return 0

    descs = sorted(IDX.glob("*.desc.json"))
    work = IDX / "_work"
    orig = VI.get_index(str(IDX))
    print(f"real descriptors: {len(descs)}; kp files: {len(list(work.glob('*.kp.json')))}; "
          f"ORIGINAL get_index refs={len(orig.refs)} skipped_json={orig.skipped_json}")

    records, usable = [], 0
    for f in descs:
        stem = f.stem.replace(".desc", "")
        if not (work / f"{stem}.kp.json").is_file():
            continue
        d = json.loads(f.read_text())
        src = d.get("source") or {}
        req = {
            "reference_clip_id": src.get("path") or stem,
            "clip_cas": src.get("fingerprint") or stem,
            "kp_cas": stem,
            "created_at": "2026-06-28T00:00:00Z",
        }
        records += recmaker.reference_records_from_descriptor(req, d)
        usable += 1
    print(f"records built from real descriptors (kp present): {usable}")

    with tempfile.TemporaryDirectory() as out:
        summ = bridge.materialize_index(records, kp_resolver=bridge._dir_kp_resolver(str(work)), out_dir=out)
        new = VI.get_index(out)
        leaked = [k for k, _, _ in new.refs if "/" in k]
        print(f"materialized count={summ['count']}; MATERIALIZED get_index refs={len(new.refs)} "
              f"skipped_json={new.skipped_json}; path-leaked keys={len(leaked)}")
        ok = (
            len(new.refs) > 0
            and new.skipped_json == 0
            and len(leaked) == 0
            and len(new.refs) == len(orig.refs)
        )
        print(f"REAL-DATA INGEST->RECORD->MATERIALIZE->MATCHER-LOAD: {'PASS' if ok else 'FAIL'} "
              f"(orig {len(orig.refs)} == materialized {len(new.refs)})")
        return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
