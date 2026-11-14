"""LIVE-1 assembly-shape proof: the matcher index ships as ONE content-addressed artifact (a tar), not N mounts.

WHY THIS EXISTS (the design decision it settles):
The frozen matcher reads a DIRECTORY — `<key>.desc.json` (top level) + `_work/<key>.kp.json` per clip. The engine's
`compute.process` mounts ONE FILE per input (`ProcessInputSource = Inline | BlobRef{hash}` — verified in
architect/crates/execution-types/src/process_types.rs). There is NO "mount a whole CAS directory" source. So a
MULTI-clip index reaches a match job dir by exactly one of:
  (a) N per-entry mounts  -> needs a record-set-bound DYNAMIC input list (UNVERIFIED engine capability), or
  (b) ONE artifact (tar of the materialized dir) mounted via the ALREADY-PROVEN single BlobRef, untarred by the
      process into the job dir.
This test proves (b) is functionally correct end-to-end: materialize N records -> tar -> mount-as-one-blob
(simulated: untar to a FRESH job dir) -> the REAL `viewpoint_index.get_index` loads the SAME refs. (b) uses only
proven primitives (single BlobRef + an OS process that untars — WASM-is-the-brain), so the assembly shape needs
NO new engine capability. The ONLY remaining live-gated question is mount COST for a large (614M) artifact — a
perf measurement, not a buildability question.

ENV NOTE: the pure tar round-trip asserts always run (stdlib only). The decisive matcher-load assertion needs the
show-up-video-tennis tools/match dir + numpy + sklearn (NO torch); it SKIPS honestly if absent (never false-pass).

Run: python3 test_index_artifact_roundtrip.py   ->   exit 0 = PASS (or honest SKIP), exit 1 = FAIL.
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

_PASS = 0
_FAIL = 0


def check(name, fn):
    global _PASS, _FAIL
    try:
        fn()
        print(f"PASS {name}")
        _PASS += 1
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        _FAIL += 1


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


BRIDGE = _load(HERE / "materialize-index-from-reference-records.py", "materialize_bridge")
RECMAKER = _load(HERE / "make-reference-records-from-descriptor.py", "ingest_recmaker")


def _descriptor(path: str, fingerprint: str, vec):
    return {
        "schema": "motion-clip-descriptor.v1",
        "source": {"path": path, "fingerprint": fingerprint},
        "fps": 30.0,
        "frames": 120,
        "clip_t0": 0.0,
        "clip_t1": 4.0,
        "windows": [{
            "t0": 0.5, "t1": 1.5, "full_swing": True, "peak_t": 1.0,
            "viewpoint": {"vec": vec}, "heading": {"deg": 12.0}, "quality": 0.8,
            "state": {"start": 0.5, "contact": 1.0, "end": 1.5},
        }],
        "salience_fp": "sfp", "build_fp": "bfp",
    }


def _kp_text():
    return json.dumps({"fps": 30.0, "frames": [{"t": 0.0, "kp": [[1.0, 2.0, 0.9]]}]})


def _two_records():
    """Two DISTINCT reference clips (different clip_cas/kp_cas/viewpoint) -> a real MULTI-clip index."""
    specs = [
        ("/orig/a.mp4", "aaaa1111aaaa1111", "kp_a", [0.1, 0.2, 0.3, 0.9]),
        ("/orig/b.mp4", "bbbb2222bbbb2222", "kp_b", [0.9, 0.3, 0.2, 0.1]),
    ]
    records, kp = [], {}
    for path, fp, kpcas, vec in specs:
        req = {"reference_clip_id": path, "clip_cas": fp, "kp_cas": kpcas, "created_at": "2026-06-28T00:00:00Z"}
        records += RECMAKER.reference_records_from_descriptor(req, _descriptor(path, fp, vec))
        kp[kpcas] = _kp_text()
    return records, (lambda c: kp.get(c))


BUILDER = _load(HERE / "build-index-artifact.py", "build_artifact")


def _tar_dir(src_dir: str, tar_path: str):
    """Pack the materialized index dir into ONE artifact via the SINGLE canonical packer (no divergent impl)."""
    BUILDER.pack_index_dir(src_dir, tar_path)


def _untar(tar_path: str, dest_dir: str):
    """What the match process does after the engine mounts the ONE blob: untar into the job dir."""
    with tarfile.open(tar_path, "r") as tf:
        tf.extractall(dest_dir)


# ---- pure round-trip (always runs, stdlib only) ----

def test_tar_roundtrip_preserves_index_layout():
    records, resolver = _two_records()
    with tempfile.TemporaryDirectory() as built, tempfile.TemporaryDirectory() as art, \
            tempfile.TemporaryDirectory() as job:
        summary = BRIDGE.materialize_index(records, kp_resolver=resolver, out_dir=built)
        assert summary["count"] == 2, f"expected 2 entries, got {summary['count']}"
        tar_path = str(Path(art) / "index.tar")
        _tar_dir(built, tar_path)
        _untar(tar_path, job)
        # the untarred job dir must be byte-identical in layout to the built dir
        built_files = sorted(str(p.relative_to(built)) for p in Path(built).rglob("*") if p.is_file())
        job_files = sorted(str(p.relative_to(job)) for p in Path(job).rglob("*") if p.is_file())
        assert built_files == job_files, f"tar round-trip changed the layout:\n{built_files}\n{job_files}"
        for rel in built_files:
            assert (Path(built) / rel).read_bytes() == (Path(job) / rel).read_bytes(), f"byte mismatch: {rel}"
        # both desc + both kp present
        assert sum(1 for f in job_files if f.endswith(".desc.json")) == 2
        assert sum(1 for f in job_files if f.startswith("_work/") and f.endswith(".kp.json")) == 2


# ---- decisive: the REAL frozen matcher loads the index from the untarred artifact ----

def test_matcher_loads_index_from_untarred_artifact():
    if not MATCHER_DIR.is_dir():
        print("  (SKIP matcher-load: show-up-video-tennis tools/match absent)")
        return
    sys.path.insert(0, str(MATCHER_DIR))
    try:
        import viewpoint_index as VI  # numpy + sklearn BallTree, NO torch
    except Exception as exc:  # noqa: BLE001
        print(f"  (SKIP matcher-load: viewpoint_index import failed: {type(exc).__name__})")
        return
    records, resolver = _two_records()
    with tempfile.TemporaryDirectory() as built, tempfile.TemporaryDirectory() as art, \
            tempfile.TemporaryDirectory() as job:
        BRIDGE.materialize_index(records, kp_resolver=resolver, out_dir=built)
        tar_path = str(Path(art) / "index.tar")
        _tar_dir(built, tar_path)
        _untar(tar_path, job)
        vi = VI.get_index(job)  # load straight from the untarred (mounted-artifact) job dir
        assert vi.skipped_json == 0, f"matcher skipped {vi.skipped_json} desc from the untarred artifact"
        assert len(vi.refs) == 2, f"matcher indexed {len(vi.refs)} refs from the artifact, expected 2"
        leaked = [k for k, _, _ in vi.refs if "/" in k]
        assert not leaked, f"content-address keys leaked a path separator: {leaked}"


if __name__ == "__main__":
    check("tar_roundtrip_preserves_index_layout", test_tar_roundtrip_preserves_index_layout)
    check("matcher_loads_index_from_untarred_artifact", test_matcher_loads_index_from_untarred_artifact)
    print(f"PASS={_PASS} FAIL={_FAIL}")
    raise SystemExit(1 if _FAIL else 0)
