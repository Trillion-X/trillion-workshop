#!/usr/bin/env python3
"""Unit test for the engine-staged kp placer (the engine-flat-mount -> materializer-key-path adapter, L098).

Verifies: (1) each flat staged blob `staged/<i>.kp.json` is copied to `_work/<_safe_key(clip_cas)>.kp.json`
exactly where materialize-index-from-reference-records.py --engine-staged fail-closed verifies it;
(2) the key matches the materializer's own SSOT key function (no divergence); (3) a missing staged blob
fails CLOSED (no partial/kp-less index); (4) multi-record ordering pairs staged/<i> to records[i].
Run: python3 test_place_engine_staged_kp.py"""
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, _HERE / filename)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


placer = _load("_placer", "place-engine-staged-kp.py")
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


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj), encoding="utf-8")


def test_places_at_materializer_key_path() -> None:
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        clip_cas = "1f:beadfeed00"
        _write(d / "records.json", {"records": [_rec(clip_cas, "1f:kp00")]})
        _write(d / "staged" / "0.kp.json", [[[1, 2, 0.9]]])
        summary = placer.place(str(d / "records.json"), str(d / "staged"), str(d / "index"))
        key = mat._safe_key(clip_cas)  # SSOT: the placer key MUST equal the materializer key
        placed = d / "index" / "_work" / f"{key}.kp.json"
        assert placed.is_file(), f"kp not placed at materializer path {placed}"
        assert summary["keys"] == [key], summary
        # the materializer's --engine-staged mode must now succeed (kp present where it verifies)
        out = mat.materialize_index(
            [_rec(clip_cas, "1f:kp00")], kp_resolver=None, out_dir=str(d / "index")
        )
        assert out["count"] == 1 and out["keys"] == [key], out
        assert (d / "index" / f"{key}.desc.json").is_file()
    print("ok: places at materializer key path + materialize --engine-staged succeeds")


def test_missing_staged_blob_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        _write(d / "records.json", {"records": [_rec("1f:aa", "1f:kpaa")]})
        # no staged/0.kp.json on purpose
        raised = False
        try:
            placer.place(str(d / "records.json"), str(d / "staged"), str(d / "index"))
        except SystemExit:
            raised = True
        assert raised, "missing staged kp blob must fail closed (SystemExit), got success"
    print("ok: missing staged blob fails closed")


def test_multi_record_ordering() -> None:
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        recs = [_rec("1f:c0", "1f:k0"), _rec("1f:c1", "1f:k1")]
        _write(d / "records.json", {"records": recs})
        _write(d / "staged" / "0.kp.json", [[[0, 0, 1]]])
        _write(d / "staged" / "1.kp.json", [[[9, 9, 1]]])
        summary = placer.place(str(d / "records.json"), str(d / "staged"), str(d / "index"))
        assert summary["keys"] == [mat._safe_key("1f:c0"), mat._safe_key("1f:c1")], summary
        # staged/1 must land on record[1]'s key, not record[0]'s
        assert (d / "index" / "_work" / f"{mat._safe_key('1f:c1')}.kp.json").read_text() == json.dumps([[[9, 9, 1]]])
    print("ok: multi-record ordering pairs staged[i] -> records[i]")


if __name__ == "__main__":
    test_places_at_materializer_key_path()
    test_missing_staged_blob_fails_closed()
    test_multi_record_ordering()
    print("ALL PASS")
