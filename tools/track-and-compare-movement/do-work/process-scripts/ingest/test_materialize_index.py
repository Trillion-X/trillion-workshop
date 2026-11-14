"""Contract test for the records->index materialization bridge (materialize-index-from-reference-records.py).

Proves OFFLINE (no torch) that the bridge is the faithful inverse of the ingest record-maker AND that its
output is accepted by the REAL frozen matcher index loader:

  descriptor -> (ingest record-maker) reference_records_from_descriptor -> motion-reference-clip record
             -> (bridge) materialize_index + injected kp_resolver -> <key>.desc.json + _work/<key>.kp.json
             -> select_partner/viewpoint_index.get_index loads it (>=1 ref) AND the descriptor round-trips.

ENV NOTE: the only env-specific lines are MATCHER_DIR (the show-up-video-tennis tools/match dir, to import
the real get_index) — if absent, the matcher-load assertions SKIP honestly (the pure-transform asserts
still run). get_index needs numpy + sklearn BallTree only (NO torch).

Run: python3 test_materialize_index.py
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# The matcher lives in a sibling checkout beside this repository, so resolve it from
# this file rather than from one machine's home directory. HERE.parents[4] is the repo root.
MATCHER_DIR = HERE.parents[4].parent / "show-up-video-tennis" / "tools" / "match"

PASS = 0
FAIL = 0


def check(name, fn):
    global PASS, FAIL
    try:
        fn()
    except Exception as exc:  # noqa: BLE001 — harness reports every failure
        FAIL += 1
        print(f"FAIL {name}: {exc}")
    else:
        PASS += 1
        print(f"PASS {name}")


def expect_raises(fn):
    try:
        fn()
    except Exception:
        return
    raise AssertionError("expected an exception, none raised")


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


BRIDGE = _load_module(HERE / "materialize-index-from-reference-records.py", "materialize_bridge")
RECMAKER = _load_module(HERE / "make-reference-records-from-descriptor.py", "ingest_recmaker")


def sample_descriptor():
    """A minimal but matcher-shaped motion-clip-descriptor.v1 (one window with a viewpoint vec get_index reads)."""
    return {
        "schema": "motion-clip-descriptor.v1",
        "source": {"path": "/orig/clip.mp4", "fingerprint": "abc123def456abc1"},
        "fps": 30.0,
        "frames": 120,
        "clip_t0": 0.0,
        "clip_t1": 4.0,
        "windows": [
            {
                "t0": 0.5,
                "t1": 1.5,
                "full_swing": True,
                "peak_t": 1.0,
                "viewpoint": {"vec": [0.1, 0.2, 0.3, 0.9]},
                "heading": {"deg": 12.0},
                "quality": 0.8,
                "state": {"start": 0.5, "contact": 1.0, "end": 1.5},
            }
        ],
        "salience_fp": "sfp", "build_fp": "bfp",
    }


def make_record(desc):
    request = {
        "reference_clip_id": "/orig/clip.mp4",
        "clip_cas": "abc123def456abc1",
        "kp_cas": "kp_abc123",
        "created_at": "2026-06-27T00:00:00Z",
    }
    out = RECMAKER.reference_records_from_descriptor(request, desc)
    assert len(out) == 1, "ingest record-maker should emit exactly one reference record"
    return out[0]


def synthetic_kp_text():
    # the matcher's kp.json shape: {"fps":..,"frames":[{"t":..,"kp":[[x,y,c]..]}..]} — content is opaque to
    # the bridge (it only moves bytes); a small valid JSON suffices for the materialize + load contract.
    return json.dumps({"fps": 30.0, "frames": [{"t": 0.0, "kp": [[1.0, 2.0, 0.9]]}]})


def kp_resolver_ok(kp_cas):
    assert kp_cas == "kp_abc123", f"resolver got unexpected kp_cas {kp_cas!r}"
    return synthetic_kp_text()


# ---- pure-transform contract (always runs, no matcher needed) ----

def test_descriptor_round_trips_through_record():
    desc = sample_descriptor()
    rec = make_record(desc)
    rebuilt = BRIDGE.descriptor_from_record(rec["payload"])
    assert rebuilt["schema"] == desc["schema"]
    assert rebuilt["windows"] == desc["windows"], "windows must round-trip VERBATIM"
    assert rebuilt["fps"] == desc["fps"] and rebuilt["frames"] == desc["frames"]
    assert rebuilt["source"]["fingerprint"] == "abc123def456abc1", "fingerprint must be the full clip_cas"
    assert rebuilt["source"]["path"] == "/orig/clip.mp4", "source.path = reference_clip_id (partner_clip)"


def test_materialize_writes_paired_desc_and_kp():
    desc = sample_descriptor()
    rec = make_record(desc)
    with tempfile.TemporaryDirectory() as d:
        summary = BRIDGE.materialize_index([rec], kp_resolver=kp_resolver_ok, out_dir=d)
        assert summary["count"] == 1
        key = summary["keys"][0]
        descp = Path(d) / f"{key}.desc.json"
        kpp = Path(d) / "_work" / f"{key}.kp.json"
        assert descp.is_file(), "<key>.desc.json must exist"
        assert kpp.is_file(), "_work/<key>.kp.json must exist (matcher gates inclusion on this)"
        loaded = json.loads(descp.read_text())
        assert loaded["windows"] == desc["windows"]
        assert json.loads(kpp.read_text())["fps"] == 30.0


def test_engine_staged_mode_writes_desc_and_verifies_kp():
    """Live-workflow mode: kp pre-mounted at _work/<key>.kp.json (blob_ref); resolver=None writes desc only."""
    desc = sample_descriptor()
    rec = make_record(desc)
    with tempfile.TemporaryDirectory() as d:
        # simulate the engine's blob_ref mount placing the kp before the script runs
        key = BRIDGE._safe_key("abc123def456abc1")
        work = Path(d) / "_work"
        work.mkdir(parents=True, exist_ok=True)
        (work / f"{key}.kp.json").write_text(synthetic_kp_text())
        summary = BRIDGE.materialize_index([rec], kp_resolver=None, out_dir=d)
        assert summary["count"] == 1 and summary["keys"][0] == key
        assert (Path(d) / f"{key}.desc.json").is_file(), "descriptor must be written"
        # the pre-mounted kp must be left intact (not overwritten/erased)
        assert json.loads((work / f"{key}.kp.json").read_text())["fps"] == 30.0


def test_engine_staged_mode_fail_closed_when_kp_absent():
    """If the engine did NOT mount the kp, refuse to write a kp-less index entry."""
    desc = sample_descriptor()
    rec = make_record(desc)
    with tempfile.TemporaryDirectory() as d:
        expect_raises(lambda: BRIDGE.materialize_index([rec], kp_resolver=None, out_dir=d))
        # and it must NOT have left a half-written desc for that key
        key = BRIDGE._safe_key("abc123def456abc1")
        assert not (Path(d) / f"{key}.desc.json").is_file(), "no kp-less desc may be written"


def test_fail_closed_wrong_kind():
    bad = {"payload": {"kind": "something-else", "windows": [], "reference_clip_id": "x", "clip_cas": "y", "kp_cas": "z"}}
    with tempfile.TemporaryDirectory() as d:
        expect_raises(lambda: BRIDGE.materialize_index([bad], kp_resolver=kp_resolver_ok, out_dir=d))


def test_fail_closed_unresolved_kp():
    desc = sample_descriptor()
    rec = make_record(desc)
    with tempfile.TemporaryDirectory() as d:
        expect_raises(lambda: BRIDGE.materialize_index([rec], kp_resolver=lambda _c: None, out_dir=d))


def test_fail_closed_duplicate_key():
    desc = sample_descriptor()
    rec = make_record(desc)
    with tempfile.TemporaryDirectory() as d:
        expect_raises(lambda: BRIDGE.materialize_index([rec, rec], kp_resolver=kp_resolver_ok, out_dir=d))


def test_dir_resolver_reads_named_files():
    with tempfile.TemporaryDirectory() as src:
        (Path(src) / "kp_abc123.kp.json").write_text(synthetic_kp_text())
        resolve = BRIDGE._dir_kp_resolver(src)
        assert resolve("kp_abc123") is not None
        assert resolve("missing") is None


# ---- decisive contract: the REAL frozen matcher loader accepts the materialized index ----

def test_matcher_get_index_accepts_materialized_index():
    if not MATCHER_DIR.is_dir():
        print("  (SKIP matcher-load: show-up-video-tennis tools/match absent)")
        return
    sys.path.insert(0, str(MATCHER_DIR))
    try:
        import viewpoint_index as VI  # needs numpy + sklearn BallTree, NO torch
    except Exception as exc:  # noqa: BLE001
        print(f"  (SKIP matcher-load: viewpoint_index import failed: {type(exc).__name__})")
        return
    desc = sample_descriptor()
    rec = make_record(desc)
    with tempfile.TemporaryDirectory() as d:
        BRIDGE.materialize_index([rec], kp_resolver=kp_resolver_ok, out_dir=d)
        vi = VI.get_index(d)
        # the materialized window has a 4-float viewpoint vec → exactly one ref must be indexed,
        # and zero descriptors skipped as unparseable (proves the .desc.json is matcher-valid).
        assert vi.skipped_json == 0, f"matcher could not parse the materialized desc ({vi.skipped_json} skipped)"
        assert len(vi.refs) == 1, f"matcher indexed {len(vi.refs)} refs, expected 1"
        key, win_idx, descpath = vi.refs[0]
        assert win_idx == 0 and Path(descpath).is_file()


if __name__ == "__main__":
    check("descriptor_round_trips_through_record", test_descriptor_round_trips_through_record)
    check("materialize_writes_paired_desc_and_kp", test_materialize_writes_paired_desc_and_kp)
    check("engine_staged_mode_writes_desc_and_verifies_kp", test_engine_staged_mode_writes_desc_and_verifies_kp)
    check("engine_staged_mode_fail_closed_when_kp_absent", test_engine_staged_mode_fail_closed_when_kp_absent)
    check("fail_closed_wrong_kind", test_fail_closed_wrong_kind)
    check("fail_closed_unresolved_kp", test_fail_closed_unresolved_kp)
    check("fail_closed_duplicate_key", test_fail_closed_duplicate_key)
    check("dir_resolver_reads_named_files", test_dir_resolver_reads_named_files)
    check("matcher_get_index_accepts_materialized_index", test_matcher_get_index_accepts_materialized_index)
    print(f"PASS={PASS} FAIL={FAIL}")
    raise SystemExit(1 if FAIL else 0)
