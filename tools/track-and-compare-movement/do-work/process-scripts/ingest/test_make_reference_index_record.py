#!/usr/bin/env python3
"""Unit test for the `motion-reference-index` discovery-record producer.

Verifies: (1) the record shape (kind/schema/index_ref_hash/reference_clip_ids/reference_count) +
discovery address/path; (2) clip ids are extracted in order from the reference-clip records the index was
built from (reference_clip_id, falling back to clip_cas); (3) fail-closed on a missing index hash / created_at
/ a record with no clip identity; (4) optional fields appear ONLY when supplied (L117, no invented values);
(5) the same id key the materializer uses round-trips into the record. Run: python3 test_make_reference_index_record.py"""
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, _HERE / filename)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader, f"cannot load {filename}"
    spec.loader.exec_module(mod)
    return mod


maker = _load("_idxrec", "make-reference-index-record.py")


def _ref_rec(clip_id: str, *, use_clip_cas: bool = False) -> dict:
    payload = {"kind": "motion-reference-clip", "clip_cas": f"1f:{clip_id}cas", "kp_cas": f"1f:{clip_id}kp"}
    if not use_clip_cas:
        payload["reference_clip_id"] = clip_id
    return {"address": f"package::motion-analysis::reference-clip::{clip_id}", "path": ["motion-analysis", "content-media-evidence"], "payload": payload}


def test_record_shape_and_clip_ids() -> None:
    recs = {"records": [_ref_rec("alpha"), _ref_rec("beta")]}
    out = maker.reference_index_record(index_ref_hash="1f:deadbeef", reference_records=recs, created_at="2026-06-28T00:00:00Z")
    p = out["payload"]
    assert p["kind"] == "motion-reference-index" and p["schema"] == "motion-reference-index.v1", p
    assert p["index_ref_hash"] == "1f:deadbeef", p
    assert p["reference_clip_ids"] == ["alpha", "beta"] and p["reference_count"] == 2, p
    assert out["address"] == "package::motion-analysis::reference-index::1f:deadbeef", out
    assert out["path"] == ["motion-analysis", "reference-index"], out
    # no optional fields invented
    assert "comparison_spec_ref" not in p and "index_byte_len" not in p, p
    print("ok: record shape + clip ids in order + discovery address/path + no invented optionals")


def test_clip_cas_fallback_and_order() -> None:
    recs = [_ref_rec("c0", use_clip_cas=True), _ref_rec("c1")]  # bare list + one falls back to clip_cas
    p = maker.reference_index_record(index_ref_hash="1f:aa", reference_records=recs, created_at="t")["payload"]
    assert p["reference_clip_ids"] == ["1f:c0cas", "c1"], p  # record[0] has no reference_clip_id -> clip_cas
    print("ok: bare-list input + clip_cas fallback, order preserved")


def test_optional_fields_present_when_supplied() -> None:
    p = maker.reference_index_record(
        index_ref_hash="1f:bb", reference_records=[_ref_rec("x")], created_at="t",
        index_id="pro-corpus-v1", comparison_spec_ref="package::motion-comparison::spec::default", index_byte_len="4065280",
    )
    assert p["address"] == "package::motion-analysis::reference-index::pro-corpus-v1", p
    assert p["payload"]["comparison_spec_ref"].endswith("spec::default"), p
    assert p["payload"]["index_byte_len"] == 4065280, p  # coerced to int
    print("ok: optional index_id/comparison_spec_ref/index_byte_len present + typed when supplied")


def test_fail_closed() -> None:
    for kwargs in (
        dict(index_ref_hash="", reference_records=[_ref_rec("x")], created_at="t"),       # missing hash
        dict(index_ref_hash="1f:cc", reference_records=[_ref_rec("x")], created_at=""),    # missing created_at
        dict(index_ref_hash="1f:cc", reference_records=[{"address": "a", "payload": {}}], created_at="t"),  # no clip identity
        dict(index_ref_hash="1f:cc", reference_records={"records": "notalist"}, created_at="t"),            # malformed records
    ):
        raised = False
        try:
            maker.reference_index_record(**kwargs)
        except ValueError:
            raised = True
        assert raised, f"expected ValueError for {kwargs}"
    print("ok: fail-closed on missing hash / created_at / no-clip-identity / malformed records")


def test_input_json_dispatch_shape() -> None:
    """The live action mounts the whole dispatch input as --input-json; absent optionals must NOT appear
    (proves the workflow never needs a per-optional argv slot that an absent input would turn into null)."""
    import subprocess
    import sys
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        (d / "refs.json").write_text(json.dumps({"records": [_ref_rec("alpha"), _ref_rec("beta")]}), encoding="utf-8")
        # dispatch object with ONLY the required scalars present (index_id/comparison_spec_ref/index_byte_len absent)
        (d / "input.json").write_text(json.dumps({"index_ref_hash": "1f:810d2295", "created_at": "2026-06-28T00:00:00Z"}), encoding="utf-8")
        script = _HERE / "make-reference-index-record.py"
        subprocess.run(
            [sys.executable, str(script), "--input-json", str(d / "input.json"),
             "--reference-records-json", str(d / "refs.json"), "--output-json", str(d / "out.json")],
            check=True,
        )
        out = json.loads((d / "out.json").read_text())
        p = out["records"][0]["payload"]
        assert p["index_ref_hash"] == "1f:810d2295" and p["reference_count"] == 2, out
        assert p["reference_clip_ids"] == ["alpha", "beta"], out
        assert "comparison_spec_ref" not in p and "index_byte_len" not in p, p  # absent optionals stay absent
        assert out["records"][0]["address"] == "package::motion-analysis::reference-index::1f:810d2295", out
        # now WITH optionals in the dispatch object
        (d / "input2.json").write_text(json.dumps({
            "index_ref_hash": "1f:bb", "created_at": "t", "index_id": "pro-corpus-v1",
            "comparison_spec_ref": "package::motion-comparison::spec::default", "index_byte_len": "4065280",
        }), encoding="utf-8")
        subprocess.run(
            [sys.executable, str(script), "--input-json", str(d / "input2.json"),
             "--reference-records-json", str(d / "refs.json"), "--output-json", str(d / "out2.json")],
            check=True,
        )
        p2 = json.loads((d / "out2.json").read_text())["records"][0]
        assert p2["address"].endswith("reference-index::pro-corpus-v1"), p2
        assert p2["payload"]["comparison_spec_ref"].endswith("spec::default") and p2["payload"]["index_byte_len"] == 4065280, p2
    print("ok: --input-json dispatch shape — absent optionals stay absent, present optionals applied")


def test_cli_roundtrip() -> None:
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        (d / "refs.json").write_text(json.dumps({"records": [_ref_rec("alpha"), _ref_rec("beta")]}), encoding="utf-8")
        out = maker.build_output({
            "index_ref_hash": "1f:feed", "reference_records": json.loads((d / "refs.json").read_text()),
            "created_at": "2026-06-28T00:00:00Z", "index_id": None, "comparison_spec_ref": None, "index_byte_len": None,
        })
        assert out["summary"] == {"record_count": 1, "reference_count": 2}, out
        assert out["records"][0]["payload"]["index_ref_hash"] == "1f:feed", out
    print("ok: build_output wraps one record with a correct summary")


if __name__ == "__main__":
    test_record_shape_and_clip_ids()
    test_clip_cas_fallback_and_order()
    test_optional_fields_present_when_supplied()
    test_fail_closed()
    test_input_json_dispatch_shape()
    test_cli_roundtrip()
    print("ALL PASS")
