"""test_build_index_artifact.py — the turnkey index-artifact builder produces a DETERMINISTIC, matcher-loadable
.tar from reference-clip records. Synthetic asserts always run (stdlib only); a real-clip SUBSET + matcher-load
SKIP honestly when the show-up-video-tennis matcher dir is absent.

Run: python3 test_build_index_artifact.py   ->   exit 0 = all PASS (or honest SKIP), exit 1 = FAIL.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
# The matcher lives in a sibling checkout beside this repository, so resolve it from
# this file rather than from one machine's home directory. HERE.parents[4] is the repo root.
MATCHER_DIR = HERE.parents[4].parent / "show-up-video-tennis" / "tools" / "match"
IDX = MATCHER_DIR / "index_jib"
_PASS = 0
_FAIL = 0


def check(name, fn):
    global _PASS, _FAIL
    try:
        fn(); print(f"PASS {name}"); _PASS += 1
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL {name}: {type(exc).__name__}: {exc}"); _FAIL += 1


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod


BUILDER = _load(HERE / "build-index-artifact.py", "build_artifact")
RECMAKER = _load(HERE / "make-reference-records-from-descriptor.py", "ingest_recmaker")


def _desc(path, fp, vec):
    return {"schema": "motion-clip-descriptor.v1", "source": {"path": path, "fingerprint": fp},
            "fps": 30.0, "frames": 120, "clip_t0": 0.0, "clip_t1": 4.0,
            "windows": [{"t0": 0.5, "t1": 1.5, "full_swing": True, "peak_t": 1.0,
                         "viewpoint": {"vec": vec}, "heading": {"deg": 12.0}, "quality": 0.8,
                         "state": {"start": 0.5, "contact": 1.0, "end": 1.5}}],
            "salience_fp": "sfp", "build_fp": "bfp"}


def _synth_records_and_kpdir(tmp):
    specs = [("/o/a.mp4", "aaaa1111aaaa1111", "kp_a", [0.1, 0.2, 0.3, 0.9]),
             ("/o/b.mp4", "bbbb2222bbbb2222", "kp_b", [0.9, 0.3, 0.2, 0.1])]
    kpdir = Path(tmp) / "kp"; kpdir.mkdir()
    records = []
    for path, fp, kpcas, vec in specs:
        (kpdir / f"{kpcas}.kp.json").write_text(json.dumps({"fps": 30.0, "frames": [{"t": 0.0, "kp": [[1.0, 2.0, 0.9]]}]}))
        req = {"reference_clip_id": path, "clip_cas": fp, "kp_cas": kpcas, "created_at": "2026-06-28T00:00:00Z"}
        records += RECMAKER.reference_records_from_descriptor(req, _desc(path, fp, vec))
    return records, str(kpdir)


def test_builds_tar_with_entries_and_hash():
    with tempfile.TemporaryDirectory() as t:
        recs, kpdir = _synth_records_and_kpdir(t)
        out = str(Path(t) / "index.tar")
        res = BUILDER.build_index_artifact(recs, kp_source_dir=kpdir, out_tar=out)
        assert res["entries"] == 2, res
        assert Path(out).is_file() and res["bytes"] > 0
        assert len(res["sha256"]) == 64
        # the tar contains 2 desc + 2 kp
        with tarfile.open(out) as tf:
            names = tf.getnames()
        assert sum(1 for n in names if n.endswith(".desc.json")) == 2
        assert sum(1 for n in names if n.startswith("_work/") and n.endswith(".kp.json")) == 2


def test_deterministic_hash_across_runs():
    with tempfile.TemporaryDirectory() as t:
        recs, kpdir = _synth_records_and_kpdir(t)
        a = BUILDER.build_index_artifact(recs, kp_source_dir=kpdir, out_tar=str(Path(t) / "a.tar"))
        b = BUILDER.build_index_artifact(recs, kp_source_dir=kpdir, out_tar=str(Path(t) / "b.tar"))
        assert a["sha256"] == b["sha256"], f"non-deterministic tar: {a['sha256']} != {b['sha256']}"


def test_real_subset_matcher_loads_from_artifact():
    if not IDX.is_dir() or not MATCHER_DIR.is_dir():
        print("  (SKIP real-subset: index_jib / tools/match absent)"); return
    sys.path.insert(0, str(MATCHER_DIR))
    try:
        import viewpoint_index as VI  # numpy + sklearn, NO torch
    except Exception as exc:  # noqa: BLE001
        print(f"  (SKIP real-subset: viewpoint_index import failed: {type(exc).__name__})"); return
    work = IDX / "_work"
    descs = sorted(IDX.glob("*.desc.json"))
    # take ONE real descriptor with a present kp (cheap — no 613M copy)
    rec = None
    for f in descs:
        stem = f.stem.replace(".desc", "")
        if (work / f"{stem}.kp.json").is_file():
            d = json.loads(f.read_text()); src = d.get("source") or {}
            req = {"reference_clip_id": src.get("path") or stem, "clip_cas": src.get("fingerprint") or stem,
                   "kp_cas": stem, "created_at": "2026-06-28T00:00:00Z"}
            rec = RECMAKER.reference_records_from_descriptor(req, d); break
    assert rec, "no real descriptor with a present kp found"
    with tempfile.TemporaryDirectory() as t:
        out = str(Path(t) / "index.tar")
        res = BUILDER.build_index_artifact(rec, kp_source_dir=str(work), out_tar=out)
        assert res["entries"] == 1
        job = Path(t) / "job"; job.mkdir()
        with tarfile.open(out) as tf:
            tf.extractall(job)
        vi = VI.get_index(str(job))
        assert vi.skipped_json == 0 and len(vi.refs) >= 1, f"matcher: refs={len(vi.refs)} skipped={vi.skipped_json}"
        assert not [k for k, _, _ in vi.refs if "/" in k], "content-address keys leaked a path separator"
        print(f"  real-subset: built 1-clip artifact ({res['bytes']} bytes, sha256 {res['sha256'][:12]}…), matcher loaded {len(vi.refs)} ref(s)")


def test_engine_staged_mode_packs_prepopulated_index_dir():
    """ENGINE-STAGED: kp pre-placed in index_dir/_work (as the live materialize-index placer does) ->
    build_index_artifact(index_dir=...) materializes-verifies + packs via the SAME deterministic canonical
    packer, with NO kp_source_dir resolver. Proves the live action's canonical-packer path (SSOT, no raw tar)."""
    rec = [{"payload": {"kind": "motion-reference-clip", "reference_clip_id": "r", "clip_cas": "1f:cafe01",
                        "kp_cas": "1f:cafe01", "fps": 30, "frames": 12, "windows": [{"start": 0, "end": 11}],
                        "descriptor_schema": "motion-clip-descriptor.v1", "created_at": "2026-06-28T00:00:00Z"}}]
    key = BUILDER.BRIDGE._safe_key("1f:cafe01")
    with tempfile.TemporaryDirectory() as t:
        idx = Path(t) / "index"; (idx / "_work").mkdir(parents=True)
        (idx / "_work" / f"{key}.kp.json").write_text(json.dumps([[[1, 2, 0.9]]]))  # the placer's output
        out = str(Path(t) / "index.tar")
        res = BUILDER.build_index_artifact(rec, kp_source_dir=None, out_tar=out, index_dir=str(idx))
        assert res["entries"] == 1 and res["keys"] == [key], res
        assert (idx / f"{key}.desc.json").is_file(), "materialize did not write the descriptor"
        out2 = str(Path(t) / "index2.tar")
        res2 = BUILDER.build_index_artifact(rec, kp_source_dir=None, out_tar=out2, index_dir=str(idx))
        assert res["sha256"] == res2["sha256"], ("non-deterministic", res["sha256"], res2["sha256"])
        if not (MATCHER_DIR.exists() and IDX.exists()):
            print("  (SKIP engine-staged matcher-load: tools/match absent) — build+determinism asserted"); return
        sys.path.insert(0, str(MATCHER_DIR))
        try:
            import viewpoint_index as VI  # noqa: PLC0415
        except Exception as exc:  # noqa: BLE001
            print(f"  (SKIP engine-staged matcher-load: viewpoint_index import failed: {type(exc).__name__})"); return
        job = Path(t) / "job"; job.mkdir()
        with tarfile.open(out) as tf:
            tf.extractall(job)
        # structural load: the canonical tar extracts and the frozen loader parses the desc (skipped_json==0)
        # WITHOUT error. ref-count from trivial synthetic kp is not asserted here — real-pose matcher-load is
        # covered by real_subset_matcher_loads_from_artifact; this test proves the engine-staged packer path.
        vi = VI.get_index(str(job))
        assert vi.skipped_json == 0, f"matcher skipped the canonical desc: skipped={vi.skipped_json}"
        print(f"  engine-staged: canonical-packed prepopulated index_dir, deterministic sha256 {res['sha256'][:12]}…, desc parsed (skipped=0)")


if __name__ == "__main__":
    check("builds_tar_with_entries_and_hash", test_builds_tar_with_entries_and_hash)
    check("deterministic_hash_across_runs", test_deterministic_hash_across_runs)
    check("real_subset_matcher_loads_from_artifact", test_real_subset_matcher_loads_from_artifact)
    check("engine_staged_mode_packs_prepopulated_index_dir", test_engine_staged_mode_packs_prepopulated_index_dir)
    print(f"PASS={_PASS} FAIL={_FAIL}")
    raise SystemExit(1 if _FAIL else 0)
