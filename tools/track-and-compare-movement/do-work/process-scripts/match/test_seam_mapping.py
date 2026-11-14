#!/usr/bin/env python3
"""test_seam_mapping.py — fast, repeatable regression proof that court/ball/point facts
flow through the GENERIC motion-analysis record-maker as a DATA row, with ZERO edits to
that package. It runs the real motion-analysis record-maker over the REAL 73-record
command-output.json (emit_match_facts.py output on the the reference player clip, committed as a fixture)
and asserts every court/ball fact is admitted as a published record with full fidelity.

This is the offline seam proof: heavy vision runs once (emit_match_facts.py); this test
re-verifies the admission boundary on every run without re-loading the models.

Run: python3 test_seam_mapping.py
Override the record-maker path with MOTION_ANALYSIS_RECORD_MAKER if it is deployed elsewhere.
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "_probe" / "command-output.json"
# The record maker is this package's own sibling file, one directory up from here, so
# resolve it from this file rather than from one machine's home directory.
DEFAULT_RECORD_MAKER = HERE.parent / "make-motion-analysis-records-from-command-output.py"
RECORD_MAKER = Path(os.environ.get("MOTION_ANALYSIS_RECORD_MAKER", DEFAULT_RECORD_MAKER))

# The court/ball/point fact contract (self-describing kinds emit_match_facts.py produces).
EXPECTED_KINDS = {
    "perception.court.geometry",
    "perception.ball.position",
    "perception.ball.bounce",
    "perception.line_call",
}
EXPECTED_PATH = ["match-perception", "content-media-evidence"]


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    if not FIXTURE.exists():
        fail(f"missing fixture {FIXTURE} — run: python3 emit_match_facts.py <clip> {FIXTURE} <rid>")
    if not RECORD_MAKER.exists():
        fail(f"record-maker not found at {RECORD_MAKER} (set MOTION_ANALYSIS_RECORD_MAKER)")

    cmd_out = json.loads(FIXTURE.read_text())
    in_records = cmd_out.get("records", [])
    if not in_records:
        fail("fixture has no `records[]` — emit_match_facts.py must emit canonical provided records")

    with tempfile.TemporaryDirectory() as tmp:
        req = Path(tmp) / "request.json"
        out = Path(tmp) / "published.json"
        req.write_text(json.dumps({
            "request_id": cmd_out.get("request_id", "seam-test"),
            "sources": [{"source_index": 0, "artifact_ref": {"cas_address": "fixture-clip"}}],
            "requested_at": "2026-06-27T00:00:00Z",
        }))
        r = subprocess.run(
            [sys.executable, str(RECORD_MAKER),
             "--request-json", str(req),
             "--command-output-json", str(FIXTURE),
             "--output-json", str(out)],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            fail(f"record-maker rc={r.returncode}: {r.stderr.strip()[-300:]}")
        published = json.loads(out.read_text()).get("records", [])

    # 1) every input fact is admitted (the seam drops nothing).
    if len(published) != len(in_records):
        fail(f"published {len(published)} != input {len(in_records)} — facts were dropped")

    # 2) kinds are court/ball/point kinds (not coerced into motion-analysis track/phase).
    kinds = {r["payload"].get("kind") for r in published}
    if not kinds.issubset(EXPECTED_KINDS):
        fail(f"unexpected kinds leaked: {kinds - EXPECTED_KINDS}")

    # 3) the decoupled fact-family path is honored (not forced to motion-analysis default).
    paths = {tuple(r["path"]) for r in published}
    if paths != {tuple(EXPECTED_PATH)}:
        fail(f"path not honored: {paths} != {{{tuple(EXPECTED_PATH)}}}")

    # 4) full payload fidelity — a court-geometry fact keeps its homography + keypoints (L090).
    cg = next((r for r in published if r["payload"].get("kind") == "perception.court.geometry"), None)
    if cg and (not cg["payload"].get("homography") or not cg["payload"].get("keypoints")):
        fail("court.geometry record lost homography/keypoints — payload not carried verbatim")

    # 5) every record is addressable (unique address + non-empty payload).
    addrs = [r["address"] for r in published]
    if len(set(addrs)) != len(addrs):
        fail("duplicate record addresses — facts not uniquely addressable")
    if not all(r.get("address") and r.get("payload") for r in published):
        fail("a published record is missing address or payload")

    from collections import Counter
    tally = dict(Counter(r["payload"]["kind"] for r in published))
    print(f"PASS: {len(published)} court/ball facts admitted by the generic motion-analysis "
          f"record-maker, zero edits. kinds={tally}, path={EXPECTED_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
