#!/usr/bin/env python3
"""Focused tests for make-reference-records-from-descriptor.py."""

from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "make-reference-records-from-descriptor.py"

spec = importlib.util.spec_from_file_location("make_reference_records_from_descriptor", MODULE_PATH)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


PASS = 0
FAIL = 0


def check(name: str, condition: bool) -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
    else:
        FAIL += 1
        print(f"FAIL {name}")


def expect_raises(name: str, func) -> None:
    global PASS, FAIL
    try:
        func()
    except Exception:
        PASS += 1
    else:
        FAIL += 1
        print(f"FAIL {name}")


def synthetic_descriptor() -> dict:
    return {
        "schema": "motion-clip-descriptor.v1",
        "source": {"path": "/tmp/input.mov", "fingerprint": "source-fp"},
        "fps": 30,
        "frames": 180,
        "windows": [
            {
                "t0": 0.4,
                "t1": 1.2,
                "viewpoint": {"vec": [0.1, 0.2, 0.3], "confidence": 0.91},
                "heading": 12.5,
                "elevation": -3.0,
                "signature": {"a": 1, "b": [2, 3]},
                "state": {"peak": 0.73, "label": "opaque engine state"},
                "quality": {"visible": True, "score": 0.82},
            },
            {
                "t0": 2.0,
                "t1": 2.8,
                "viewpoint": {"vec": [-0.2, 0.4, 0.1], "confidence": 0.88},
                "heading": -8.0,
                "elevation": 1.5,
                "signature": {"c": {"nested": "kept"}},
                "state": {"peak": 0.66, "events": ["raw", "values"]},
                "quality": {"visible": False, "reason": "carried verbatim"},
                "extra_unseen_field": {"must": "survive"},
            },
        ],
    }


def test_reference_record() -> None:
    request = {
        "reference_clip_id": "ref-001",
        "clip_cas": "cas://clip-bytes",
        "kp_cas": "cas://pose-json",
        "created_at": "2026-06-27T12:00:00Z",
    }
    descriptor = synthetic_descriptor()
    records = module.reference_records_from_descriptor(request, descriptor)
    check("one record", len(records) == 1)
    record = records[0]
    payload = record["payload"]
    check("kind", payload["kind"] == "motion-reference-clip")
    check("reference_clip_id", payload["reference_clip_id"] == request["reference_clip_id"])
    check("clip_cas", payload["clip_cas"] == request["clip_cas"])
    check("kp_cas", payload["kp_cas"] == request["kp_cas"])
    check("fps", payload["fps"] == descriptor["fps"])
    check("frames", payload["frames"] == descriptor["frames"])
    check("both windows", len(payload["windows"]) == 2)
    check("windows verbatim", payload["windows"] == descriptor["windows"])
    check("unseen nested field preserved", payload["windows"][1]["extra_unseen_field"] == {"must": "survive"})
    check("created_at", payload["created_at"] == request["created_at"])


def test_fail_closed() -> None:
    request = {
        "reference_clip_id": "ref-001",
        "clip_cas": "cas://clip-bytes",
        "kp_cas": "cas://pose-json",
        "created_at": "2026-06-27T12:00:00Z",
    }
    bad_schema = synthetic_descriptor()
    bad_schema["schema"] = "wrong.v1"
    expect_raises("wrong schema raises", lambda: module.reference_records_from_descriptor(request, bad_schema))
    expect_raises("non-dict descriptor raises", lambda: module.reference_records_from_descriptor(request, []))
    bad_window = synthetic_descriptor()
    bad_window["windows"] = [{"ok": True}, "bad"]
    expect_raises("malformed window raises", lambda: module.reference_records_from_descriptor(request, bad_window))


def test_cli() -> None:
    request = {
        "reference_clip_id": "ref-cli",
        "clip_cas": "cas://clip",
        "kp_cas": "cas://kp",
        "created_at": "2026-06-27T13:00:00Z",
    }
    descriptor = synthetic_descriptor()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        request_path = root / "request.json"
        descriptor_path = root / "descriptor.json"
        output_path = root / "output.json"
        request_path.write_text(json.dumps(request), encoding="utf-8")
        descriptor_path.write_text(json.dumps(descriptor), encoding="utf-8")
        rc = module.main.__globals__["__name__"]
        check("module loaded", rc == "make_reference_records_from_descriptor")
        import subprocess
        import sys

        result = subprocess.run(
            [
                sys.executable,
                str(MODULE_PATH),
                "--request-json",
                str(request_path),
                "--descriptor-json",
                str(descriptor_path),
                "--output-json",
                str(output_path),
            ],
            capture_output=True,
            text=True,
        )
        check("cli rc", result.returncode == 0)
        output = json.loads(output_path.read_text(encoding="utf-8"))
        check("cli record count", output["summary"]["record_count"] == 1)
        check("cli windows verbatim", output["records"][0]["payload"]["windows"] == descriptor["windows"])


def main() -> int:
    test_reference_record()
    test_fail_closed()
    test_cli()
    print(f"PASS={PASS} FAIL={FAIL}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
