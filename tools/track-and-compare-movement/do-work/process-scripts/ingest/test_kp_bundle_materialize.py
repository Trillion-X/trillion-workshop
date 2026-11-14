#!/usr/bin/env python3
"""test_kp_bundle_materialize.py — the ANY-N kp-bundle path of the live `materialize-index` action.

The live action mounts ONE `kp.tar` bundle (member-named `0.kp.json..(N-1).kp.json` in records order),
its argv runs `tar -xf kp.tar -C staged` and then the SAME placer + builder the single-reference path used.
This proves the cardinality is one case, not two: ONE static mount serves any N references — the
dynamic-N-mount engine seam is DISSOLVED for the kp side (no per-record mount, no engine primitive).

This test reproduces the action's chain faithfully for N>1: build a kp bundle tar, untar it into a fresh
`staged/` exactly as the argv does, run the placer (engine-flat -> materializer key path, L098), run the
builder in --engine-staged mode, and assert the packed index.tar carries EACH reference's placed kp keyed
by its own clip_cas. Also proves a 1-member bundle is just the N=1 case (back-compat of the old kp_cas path).
Run: python3 test_kp_bundle_materialize.py   ->   exit 0 = all PASS, exit 1 = FAIL."""
from __future__ import annotations

import importlib.util
import json
import tarfile
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, _HERE / filename)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader, f"cannot load {filename}"
    spec.loader.exec_module(mod)
    return mod


placer = _load("_placer", "place-engine-staged-kp.py")
builder = _load("_builder", "build-index-artifact.py")
mat = _load("_mat", "materialize-index-from-reference-records.py")


def _rec(clip_cas: str, kp_cas: str) -> dict:
    return {
        "address": f"package::motion-analysis::reference-clip::{clip_cas}",
        "path": ["motion-analysis", "content-media-evidence"],
        "payload": {
            "kind": "motion-reference-clip",
            "reference_clip_id": clip_cas,
            "clip_cas": clip_cas,
            "kp_cas": kp_cas,
            "fps": 30,
            "frames": 10,
            "windows": [{"start": 0, "end": 9}],
            "descriptor_schema": "motion-clip-descriptor.v1",
            "created_at": "2026-06-28T00:00:00Z",
        },
    }


def _build_kp_bundle(bundle_path: Path, kps: list) -> None:
    """Pack the N kps as the caller does: member-named `<i>.kp.json` in records order, into ONE tar."""
    with tempfile.TemporaryDirectory() as src:
        src = Path(src)
        for i, kp in enumerate(kps):
            (src / f"{i}.kp.json").write_text(json.dumps(kp), encoding="utf-8")
        with tarfile.open(bundle_path, "w") as tf:
            for i in range(len(kps)):
                tf.add(src / f"{i}.kp.json", arcname=f"{i}.kp.json")


def _run_action_chain(d: Path, records: list, kps: list) -> Path:
    """Faithfully reproduce the live action's argv chain for the kp side:
       tar -xf kp.tar -C staged ; placer ; builder --engine-staged --index-dir index --out-tar index.tar."""
    (d / "records.json").write_text(json.dumps({"records": records}), encoding="utf-8")
    _build_kp_bundle(d / "kp.tar", kps)
    staged = d / "staged"
    staged.mkdir(parents=True, exist_ok=True)
    with tarfile.open(d / "kp.tar") as tf:  # == `tar -xf kp.tar -C staged`
        tf.extractall(staged)
    placer.place(str(d / "records.json"), str(staged), str(d / "index"))
    out_tar = d / "index.tar"
    builder.build_index_artifact(
        records, kp_source_dir=None, out_tar=str(out_tar), index_dir=str(d / "index")
    )
    return out_tar


def test_two_reference_bundle_one_mount() -> None:
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        recs = [_rec("1f:clipA0", "1f:kpA0"), _rec("1f:clipB1", "1f:kpB1")]
        kps = [[[[0, 0, 1]]], [[[9, 9, 1]]]]  # distinct kp per reference
        out_tar = _run_action_chain(d, recs, kps)
        with tarfile.open(out_tar) as tf:
            names = tf.getnames()
        work_kps = sorted(n for n in names if n.startswith("_work/") and n.endswith(".kp.json"))
        keyA = mat._safe_key("1f:clipA0")
        keyB = mat._safe_key("1f:clipB1")
        assert f"_work/{keyA}.kp.json" in work_kps, (work_kps, keyA)
        assert f"_work/{keyB}.kp.json" in work_kps, (work_kps, keyB)
        assert len(work_kps) == 2, f"expected exactly 2 placed kps, got {work_kps}"
        # each descriptor present too (the matcher-loadable index)
        assert f"{keyA}.desc.json" in names and f"{keyB}.desc.json" in names, names
    print("ok: 2-reference kp bundle -> ONE mount -> both refs placed + described (any-N via one tar)")


def test_single_member_bundle_is_n1_case() -> None:
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        recs = [_rec("1f:solo0", "1f:kpsolo")]
        out_tar = _run_action_chain(d, recs, [[[[3, 4, 0.9]]]])
        with tarfile.open(out_tar) as tf:
            names = tf.getnames()
        key = mat._safe_key("1f:solo0")
        assert f"_work/{key}.kp.json" in names, names
        assert sum(1 for n in names if n.startswith("_work/") and n.endswith(".kp.json")) == 1, names
    print("ok: 1-member bundle == the N=1 case (single-reference back-compat)")


def test_bundle_ordering_pairs_member_i_to_record_i() -> None:
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        recs = [_rec("1f:ord0", "1f:k0"), _rec("1f:ord1", "1f:k1")]
        kps = [[[[0, 0, 1]]], [[[7, 7, 1]]]]
        out_tar = _run_action_chain(d, recs, kps)
        # member 1.kp.json must land on record[1]'s key, not record[0]'s
        with tarfile.open(out_tar) as tf:
            member = tf.extractfile(f"_work/{mat._safe_key('1f:ord1')}.kp.json").read().decode()
        assert json.loads(member) == [[[7, 7, 1]]], member
    print("ok: bundle member <i> pairs to records[i] (order preserved through untar -> placer)")


if __name__ == "__main__":
    test_two_reference_bundle_one_mount()
    test_single_member_bundle_is_n1_case()
    test_bundle_ordering_pairs_member_i_to_record_i()
    print("ALL PASS")
