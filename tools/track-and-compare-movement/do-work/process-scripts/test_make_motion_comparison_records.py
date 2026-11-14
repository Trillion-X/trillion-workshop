#!/usr/bin/env python3
# packages/motion-comparison/do-work/process-scripts/test_make_motion_comparison_records.py
#
# Golden/contract lock for make-motion-comparison-records-from-match-output.py — the motion-match.v1 ->
# MotionComparisonResultRecord translation. Pure (no torch/match stack): runs on synthetic envelopes + the
# real envelope at /tmp/src_post.json when present. Run: python3 test_make_motion_comparison_records.py

from __future__ import annotations
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# the module filename has dashes — load it by path
_spec = importlib.util.spec_from_file_location(
    "mc_records", HERE / "make-motion-comparison-records-from-match-output.py")
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name}")


REQ = {
    "comparison_id": "cmp:1", "request_id": "req:1",
    "source_clip_id": "subj-clip", "reference_clip_id": "ref-clip",
    "created_at": "2026-06-27T00:00:00Z", "minimum_confidence": 0.5,
    # subject's own VIDEO + POSE content addresses — the render trigger reads these off the result record
    "subject_clip_ref": {"hash": "1f:5ubjectc11p"}, "subject_pose_ref": {"hash": "1f:5ubjectp05e"},
}


def env(result):
    return {"schema": "motion-match.v1", "subject": {"descriptor": "s.json", "pose": "s.kp", "window": 0},
            "index": "idx", "result": result}


def main():
    # ---- fail-closed ----
    for bad, label in [(["x"], "non-dict envelope"),
                       ({"schema": "wrong", "result": {}}, "wrong schema"),
                       ({"schema": "motion-match.v1"}, "missing result"),
                       ({"schema": "motion-match.v1", "result": []}, "non-dict result")]:
        try:
            M.records_from_match_envelope(REQ, bad)
            check(f"{label} -> raises", False)
        except Exception:
            check(f"{label} -> raises", True)

    # ---- a full MATCH result ----
    result = {
        "no_match": False, "dist": 0.866, "parity": "direct",
        "motion_dist": 0.2115, "view_dist": 0.2215, "heading_dist": 28.5, "corr_dist": 0.2115,
        "target_t": [0.667, 3.167], "partner_t": [352.833, 354.3],
        "target_window": 0, "partner_window": 9, "partner_clip": "/refs/fed.mp4",
        "partner_clip_cas": "1f:c2c05f0c2a006501302f2feb77b085b6630cdbd3edbd105817663d642f842989", "pool_windows": 7,
        "scorecard": {"channels": {
            "contact_height": {"dist": 0.11, "pass": True, "label": "contact height"},
            "stance_width": {"dist": 0.0152, "pass": True, "label": "stance width"},
        }},
        "sync": {"map": [0, 2, 5, 9, 9, 12], "monotonic_frac": 0.767},
    }
    recs = M.records_from_match_envelope(REQ, env(result))
    check("returns exactly one record", len(recs) == 1)
    r = recs[0]
    check("kind is motion-comparison-result", r["kind"] == "motion-comparison-result")
    check("ids carried from request", r["comparisonId"] == "cmp:1" and r["requestId"] == "req:1"
          and r["sourceClipId"] == "subj-clip" and r["referenceClipId"] == "ref-clip")
    check("createdAt from request (engine is time-free)", r["createdAt"] == "2026-06-27T00:00:00Z")

    # selected factor = the certified overall distance
    sf = r["selectedFactor"]
    check("selectedFactor is the certified distance", sf["factorKind"] == "motion-type" and sf["distance"] == 0.866)
    check("selectedFactor confidence = clamp(1-dist)", abs(sf["confidence"] - 0.134) < 1e-6)
    check("overall confidence == selectedFactor confidence", abs(r["confidence"] - sf["confidence"]) < 1e-9)

    # factor measurements: 4 cert channels + 2 scorecard
    kinds = [m["factorKind"] for m in r["factorMeasurements"]]
    dists = {m["measurementId"]: m["distance"] for m in r["factorMeasurements"]}
    check("has all 4 certified channel measurements + 2 scorecard (=6)", len(r["factorMeasurements"]) == 6)
    check("raw distances preserved verbatim (L117)", dists["cmp:1:motion_dist"] == 0.2115
          and dists["cmp:1:heading_dist"] == 28.5 and dists["cmp:1:scorecard.contact_height"] == 0.11)
    # heading uses the degree scale (180) -> confidence 1 - 28.5/180
    head = next(m for m in r["factorMeasurements"] if m["measurementId"] == "cmp:1:heading_dist")
    check("heading confidence uses the 180-degree scale", abs(head["confidence"] - (1 - 28.5 / 180)) < 1e-6)
    check("scorecard channels mapped to pose-phase", all(
        m["factorKind"] == "pose-phase" for m in r["factorMeasurements"] if m["measurementId"].startswith("cmp:1:scorecard.")))

    # null calibration
    nc = r["nullCalibration"]
    check("nullCalibration.passed True (admitted)", nc["passed"] is True)
    check("nullCalibration.minimumConfidence from request", nc["minimumConfidence"] == 0.5)
    check("no noMatchReason when matched", "noMatchReason" not in nc and "noMatchReason" not in r)

    # matchedReferenceKey: WHICH reference clip the engine selected (L098 — render consumer needs it).
    # referenceClipId stays the requested SET id; matchedReferenceKey is the winning clip (partner_clip basename).
    check("matchedReferenceKey from partner_clip basename", r["matchedReferenceKey"] == "fed.mp4")
    dj = M.records_from_match_envelope(REQ, env(
        {"no_match": False, "dist": 0.3, "target_t": [0, 1], "partner_t": [5, 6],
         "partner_clip": "/job/_index_unpacked/1f_c2c05f0c2a00.desc.json"}))[0]
    check("matchedReferenceKey strips .desc.json -> index key", dj["matchedReferenceKey"] == "1f_c2c05f0c2a00")

    # matchedReferenceClipCas: the winning reference VIDEO's content address, carried straight through from the
    # matcher's partner_clip_cas (SSOT source.fingerprint) — the render chain mounts the reference clip by THIS hash.
    check("matchedReferenceClipCas surfaced verbatim from partner_clip_cas",
          r["matchedReferenceClipCas"] == "1f:c2c05f0c2a006501302f2feb77b085b6630cdbd3edbd105817663d642f842989")
    check("matchedReferenceClipCas omitted when the matcher didn't emit it (legacy/no fingerprint)",
          "matchedReferenceClipCas" not in dj)
    nm = M.records_from_match_envelope(REQ, env(
        {"no_match": True, "reason": "no_pairs_after_rank",
         "partner_clip": "/refs/fed.mp4", "partner_clip_cas": "1f:deadbeef"}))[0]
    check("matchedReferenceClipCas omitted on no_match", "matchedReferenceClipCas" not in nm)

    # parity as a MACHINE-READABLE field (L090) — the render chain binds it directly (never parses tradeoffNote prose)
    check("parity surfaced as a clean field ('direct')", r["parity"] == "direct")
    refl = M.records_from_match_envelope(REQ, env(
        {"no_match": False, "dist": 0.3, "parity": "reflected", "target_t": [0, 1], "partner_t": [5, 6],
         "partner_clip": "/refs/x.mp4"}))[0]
    check("parity 'reflected' surfaced verbatim", refl["parity"] == "reflected")
    check("parity omitted on no_match", "parity" not in nm)

    # subjectClipRef/subjectPoseRef: the subject's own VIDEO + POSE content addresses, carried through from the
    # request so the trigger-fired render mounts the subject WITHOUT re-reading the request record (result record is
    # self-sufficient for render, L098/SSOT). Machine-readable ref objects (L090).
    check("subjectClipRef carried through from request", r["subjectClipRef"] == {"hash": "1f:5ubjectc11p"})
    check("subjectPoseRef carried through from request", r["subjectPoseRef"] == {"hash": "1f:5ubjectp05e"})
    check("subjectClipRef present even on no_match (subject refs are match-independent)",
          nm["subjectClipRef"] == {"hash": "1f:5ubjectc11p"})
    # fail-safe: a request WITHOUT subject refs (legacy/partial) must OMIT the fields, never write a malformed ref
    req_bare = {"comparison_id": "cmp:2", "request_id": "req:2", "source_clip_id": "s", "reference_clip_id": "ref",
                "created_at": "2026-06-27T00:00:00Z", "minimum_confidence": 0.5}
    rb = M.records_from_match_envelope(req_bare, env(result))[0]
    check("subjectClipRef omitted when request has no subject_clip_ref (fail-safe)", "subjectClipRef" not in rb)
    check("subjectPoseRef omitted when request has no subject_pose_ref (fail-safe)", "subjectPoseRef" not in rb)
    # fail-safe: a malformed ref (no hash) must also be omitted
    req_bad = {**req_bare, "subject_clip_ref": {"nope": 1}, "subject_pose_ref": "not-a-dict"}
    rbad = M.records_from_match_envelope(req_bad, env(result))[0]
    check("subjectClipRef omitted when ref has no hash (fail-safe)", "subjectClipRef" not in rbad)
    check("subjectPoseRef omitted when ref is not a dict (fail-safe)", "subjectPoseRef" not in rbad)

    # sync windows from target_t/partner_t (NOT fabricated)
    check("sourceWindow from target_t", r["sync"]["sourceWindow"] == {"startSeconds": 0.667, "endSeconds": 3.167})
    check("referenceWindow from partner_t", r["sync"]["referenceWindow"] == {"startSeconds": 352.833, "endSeconds": 354.3})
    check("phaseAlignment from monotonic_frac 0.767 -> 'usable'", r["sync"]["phaseAlignment"] == "usable")
    check("frameOffsets has one entry per map index", len(r["sync"]["frameOffsets"]) == 6)
    fo0 = r["sync"]["frameOffsets"][0]
    check("frameOffset[0] sourceTime == window start", abs(fo0["sourceTime"] - 0.667) < 1e-3)
    check("syncEvidence frameOffsetCount matches", r["syncEvidence"]["frameOffsetCount"] == 6)

    # ---- NO_MATCH result ----
    nm = M.records_from_match_envelope(REQ, env(
        {"no_match": True, "reason": "no_admissible_motion_in_view_family", "pool_windows": 3,
         "target_t": [0, 1]}))[0]
    check("no_match: confidence 0", nm["confidence"] == 0.0)
    check("no_match: nullCalibration.passed False", nm["nullCalibration"]["passed"] is False)
    check("no_match: noMatchReason carried (record + nullCalibration)",
          nm.get("noMatchReason") == "no_admissible_motion_in_view_family"
          and nm["nullCalibration"]["noMatchReason"] == "no_admissible_motion_in_view_family")
    check("no_match: sync phaseAlignment not-measured (no warp)", nm["sync"]["phaseAlignment"] == "not-measured")
    check("no_match: frameOffsets empty (honest, not fabricated)", nm["sync"]["frameOffsets"] == [])

    # ---- GENERIC: an UNSEEN scorecard channel flows through with ZERO code change (L090) ----
    g = M.records_from_match_envelope(REQ, env(
        {"no_match": False, "dist": 0.3, "target_t": [0, 1], "partner_t": [5, 6],
         "scorecard": {"channels": {"a_brand_new_measure": {"dist": 0.05, "pass": True, "label": "brand new"}}}}))[0]
    check("unseen scorecard channel emerges as a measurement (no code change)",
          any(m["label"] == "brand new" and m["distance"] == 0.05 for m in g["factorMeasurements"]))

    # ---- REAL envelope (when present) ----
    real = Path("/tmp/src_post.json")
    if real.exists():
        rr = M.records_from_match_envelope(
            {"comparison_id": "cmp:real", "request_id": "req:real", "source_clip_id": "w9",
             "reference_clip_id": "", "created_at": "2026-06-27T00:00:00Z"},
            json.loads(real.read_text()))[0]
        check("REAL: record kind", rr["kind"] == "motion-comparison-result")
        check("REAL: referenceClipId falls back to partner_clip", rr["referenceClipId"].endswith(".mp4"))
        check("REAL: certified dist 0.866 carried", rr["selectedFactor"]["distance"] == 0.866)
        check("REAL: sourceWindow from target_t", rr["sync"]["sourceWindow"]["endSeconds"] == 3.167)
        check("REAL: scorecard channels present as measurements",
              any(m["measurementId"].startswith("cmp:real:scorecard.") for m in rr["factorMeasurements"]))
    else:
        print("  (skip REAL-envelope checks — /tmp/src_post.json absent)")

    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
