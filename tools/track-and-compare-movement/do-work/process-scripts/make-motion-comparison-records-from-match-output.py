#!/usr/bin/env python3
# packages/motion-comparison/do-work/process-scripts/make-motion-comparison-records-from-match-output.py
#
# PURPOSE: translate the crown-jewel matcher's self-describing `motion-match.v1` envelope (the stdout of the
# match process-job run_match.py) into the motion-comparison package's `motion-comparison-result` record —
# the L098 data-owner translation boundary: the match engine speaks "select_partner output"; the package and
# its UI speak `MotionComparisonResultRecord` (read-data/motion-comparison-factor-types.ts). NOTHING about
# select_partner's internal field names leaks past this file.
#
# GENERIC (L090): the certified channels and scorecard sub-channels become MotionFactorMeasurements via a
# DATA table (channel -> factorKind/label/scale), NOT per-channel branching. A new certified channel is one
# table row; a new scorecard channel flows through verbatim. NO stroke/tennis/person literal anywhere.
#
# HONEST (L117 — never fabricate): every `distance` is the RAW engine value; `confidence` is a documented
# monotonic transform of distance by a per-channel SCALE (DATA), clamped to [0,1]. Window bounds come from
# the envelope's own target_t/partner_t (the matcher's measured window seconds) — never invented. When the
# render phase-sync warp is absent (sync==None), phaseAlignment is 'not-measured' and frameOffsets is [] —
# the record states what is true, not a fabricated alignment.
#
# FAIL-CLOSED: a malformed envelope (wrong schema, missing result, non-dict) raises — the workflow surfaces
# the error rather than writing a silently-wrong comparison record.
#
# The engine is LABEL-FREE and TIME-FREE: comparisonId / requestId / clip ids / createdAt are supplied by the
# caller in `request` (the workflow passes them), never generated here.

from __future__ import annotations
import json
import sys
from typing import Any

MATCH_SCHEMA = "motion-match.v1"
RESULT_KIND = "motion-comparison-result"


def _matched_reference_key(result: dict) -> str:
    """The WINNING reference's index key — extracted from the matcher's `partner_clip` basename
    (`<key>.desc.json`). L098: the request carries the reference *set* id (e.g. a default index id); the
    engine SELECTS the specific reference clip. The render/diagnosis consumer needs WHICH clip won (to mount
    the right reference video), so the producer surfaces it here rather than letting the consumer re-derive it.
    The key maps 1:1 to the reference clip's content address (the index's safe_key of clip_cas)."""
    base = str(result.get("partner_clip") or "").rsplit("/", 1)[-1]
    for suf in (".desc.json", ".json"):
        if base.endswith(suf):
            return base[: -len(suf)]
    return base

# DATA table — certified channel -> (factorKind, human label, distance SCALE for the confidence transform).
# scale=1.0 for already-normalized [0,1] distances; heading is in DEGREES so it normalizes by 180. Adding a
# certified channel = one row here; the handler below never names a channel (L090).
_CERT_CHANNELS = [
    ("motion_dist",  "motion-type",         "motion correspondence", 1.0),
    ("view_dist",    "learned-view-factor", "camera viewpoint",       1.0),
    ("corr_dist",    "pose-phase",          "phase correspondence",   1.0),
    ("heading_dist", "hand-feature",        "camera azimuth (deg)",   180.0),
]

# phaseAlignment bands over the warp's monotonic fraction — calibration DATA (overridable via request
# 'phase_bands'); NOT magic Physics. Ordered ascending; the first band whose ceiling the value is below wins.
_DEFAULT_PHASE_BANDS = [(0.5, "weak"), (0.8, "usable"), (float("inf"), "strong")]


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def _confidence(distance: float, scale: float) -> float:
    """Monotonic decreasing distance->confidence, normalized by the channel SCALE, clamped to [0,1]."""
    return _clamp01(1.0 - (float(distance) / float(scale)))


def _measurement(comparison_id: str, channel: str, factor_kind: str, label: str,
                 distance: Any, scale: float, extra_reason: str = "") -> dict | None:
    """One MotionFactorMeasurement from a raw distance (None distance -> channel absent -> skipped)."""
    if distance is None or not isinstance(distance, (int, float)):
        return None
    conf = _confidence(distance, scale)
    reason = f"certified {label}: distance {float(distance):.4g} (scale {scale:g})"
    if extra_reason:
        reason = f"{reason}; {extra_reason}"
    return {
        "measurementId": f"{comparison_id}:{channel}",
        "factorKind": factor_kind,
        "label": label,
        "confidence": round(conf, 6),
        "distance": float(distance),
        "reason": reason,
    }


def _window(bounds: Any) -> dict:
    """MotionWindow from the envelope's [start, end] seconds list (the matcher's measured window)."""
    if isinstance(bounds, (list, tuple)) and len(bounds) == 2 and all(isinstance(b, (int, float)) for b in bounds):
        return {"startSeconds": float(bounds[0]), "endSeconds": float(bounds[1])}
    return {"startSeconds": 0.0, "endSeconds": 0.0}


def _phase_alignment(sync: Any, bands: list) -> str:
    """Map the warp monotonic_frac -> a phaseAlignment band. No warp -> 'not-measured' (honest, not fabricated)."""
    if not isinstance(sync, dict):
        return "not-measured"
    frac = sync.get("monotonic_frac")
    if not isinstance(frac, (int, float)):
        return "not-measured"
    for ceiling, name in bands:
        if frac < ceiling:
            return name
    return bands[-1][1]


def _frame_offsets(sync: Any, src_window: dict, ref_window: dict) -> list:
    """Re-express the warp `map` (per-source-frame -> reference-frame index) as MotionSyncFrameOffsets in
    SECONDS, by uniform sampling within each measured window (the standard interpretation of the alignment —
    same information, re-expressed; not invented data). Absent/empty map -> [] (honest)."""
    if not isinstance(sync, dict):
        return []
    m = sync.get("map")
    if not isinstance(m, list) or not m:
        return []
    n = len(m)
    max_idx = max((v for v in m if isinstance(v, (int, float))), default=0) or 1
    s0, s1 = src_window["startSeconds"], src_window["endSeconds"]
    r0, r1 = ref_window["startSeconds"], ref_window["endSeconds"]
    offs = []
    for i, idx in enumerate(m):
        if not isinstance(idx, (int, float)):
            continue
        src_t = s0 + (s1 - s0) * (i / (n - 1)) if n > 1 else s0
        ref_t = r0 + (r1 - r0) * (float(idx) / max_idx) if max_idx else r0
        offs.append({"sourceTime": round(src_t, 4), "referenceTime": round(ref_t, 4),
                     "offsetSeconds": round(ref_t - src_t, 4)})
    return offs


def records_from_match_envelope(request: dict, envelope: dict) -> list:
    """motion-match.v1 envelope -> [MotionComparisonResultRecord]. FAIL-CLOSED on a malformed envelope."""
    if not isinstance(envelope, dict):
        raise ValueError(f"match envelope must be a dict, got {type(envelope).__name__}")
    if envelope.get("schema") != MATCH_SCHEMA:
        raise ValueError(f"unexpected schema {envelope.get('schema')!r} (expected {MATCH_SCHEMA})")
    result = envelope.get("result")
    if not isinstance(result, dict):
        raise ValueError("match envelope has no dict `result`")

    comparison_id = str(request["comparison_id"])
    bands = request.get("phase_bands") or _DEFAULT_PHASE_BANDS
    no_match = bool(result.get("no_match"))

    # ---- factor measurements: certified channels (DATA table) + scorecard sub-channels (verbatim) ----
    measurements: list = []
    for channel, kind, label, scale in _CERT_CHANNELS:
        mm = _measurement(comparison_id, channel, kind, label, result.get(channel), scale)
        if mm:
            measurements.append(mm)
    scorecard = result.get("scorecard")
    if isinstance(scorecard, dict) and isinstance(scorecard.get("channels"), dict):
        for ch_name, ch in scorecard["channels"].items():
            if not isinstance(ch, dict):
                continue
            mm = _measurement(comparison_id, f"scorecard.{ch_name}", "pose-phase",
                              str(ch.get("label", ch_name)), ch.get("dist"), 1.0,
                              extra_reason=f"gate {'pass' if ch.get('pass') else 'fail'}")
            if mm:
                measurements.append(mm)

    # ---- selected factor: the overall certified admission distance (the decisive correctness measure) ----
    overall_dist = result.get("dist")
    if isinstance(overall_dist, (int, float)):
        selected = {
            "measurementId": f"{comparison_id}:certified",
            "factorKind": "motion-type",
            "label": "certified motion match",
            "confidence": round(_confidence(overall_dist, 1.0), 6),
            "distance": float(overall_dist),
            "reason": f"certified worst-reliable-channel distance {float(overall_dist):.4g}; parity {result.get('parity','?')}",
        }
    elif measurements:
        selected = max(measurements, key=lambda x: x["confidence"])
    else:
        selected = {"measurementId": f"{comparison_id}:none", "factorKind": "configured-fallback",
                    "label": "no credible partner", "confidence": 0.0,
                    "reason": str(result.get("reason", "no_match"))}
    confidence = 0.0 if no_match else float(selected["confidence"])

    # ---- sync: window bounds from the matcher's own target_t/partner_t; warp re-expressed honestly ----
    src_window = _window(result.get("target_t"))
    ref_window = _window(result.get("partner_t"))
    sync_raw = result.get("sync")
    sync = {
        "sourceWindow": src_window,
        "referenceWindow": ref_window,
        "phaseAlignment": _phase_alignment(sync_raw, bands),
        "frameOffsets": _frame_offsets(sync_raw, src_window, ref_window),
    }
    offs = [o["offsetSeconds"] for o in sync["frameOffsets"]]
    avg_off = sum(offs) / len(offs) if offs else 0.0
    sync_evidence = {
        "sourceWindow": {**src_window,
                         "durationSeconds": round(max(0.0, src_window["endSeconds"] - src_window["startSeconds"]), 3),
                         "midpointSeconds": round(src_window["startSeconds"] + max(0.0, src_window["endSeconds"] - src_window["startSeconds"]) / 2, 3)},
        "referenceWindow": {**ref_window,
                            "durationSeconds": round(max(0.0, ref_window["endSeconds"] - ref_window["startSeconds"]), 3),
                            "midpointSeconds": round(ref_window["startSeconds"] + max(0.0, ref_window["endSeconds"] - ref_window["startSeconds"]) / 2, 3)},
        "phaseAlignment": sync["phaseAlignment"],
        "frameOffsetCount": len(offs),
        "averageOffsetSeconds": round(avg_off, 4),
        "maxOffsetDriftSeconds": round(max((abs(o - avg_off) for o in offs), default=0.0), 4),
    }

    record = {
        "kind": RESULT_KIND,
        "comparisonId": comparison_id,
        "requestId": str(request["request_id"]),
        "sourceClipId": str(request["source_clip_id"]),
        "referenceClipId": str(request.get("reference_clip_id")
                               or (result.get("partner_clip") or "")),
        # The reference SET id above is what the caller requested; the engine selected the specific clip — the
        # render/diagnosis consumer needs WHICH clip won to mount the right reference video (L098).
        **({"matchedReferenceKey": _matched_reference_key(result)}
           if not no_match and result.get("partner_clip") else {}),
        # The winning reference VIDEO's content address (CAS SSOT), carried straight through from the matcher's
        # partner_clip_cas (= the winner descriptor's source.fingerprint). The render/diagnosis consumer mounts the
        # reference clip by THIS hash — never by reversing the lossy safe_key. Absent on no_match / legacy matchers.
        **({"matchedReferenceClipCas": str(result.get("partner_clip_cas"))}
           if not no_match and result.get("partner_clip_cas") else {}),
        # The subject's own VIDEO + POSE content addresses, carried straight through from the request so the
        # trigger-fired render mounts the subject clip+keypoints WITHOUT re-reading the request record — the result
        # record is SELF-SUFFICIENT for render (L098/SSOT). Ref objects ({hash}) mirror the input shape (L090).
        # Not gated on no_match: the subject's own refs are known regardless of match outcome. Fail-safe: only
        # emitted when a valid {hash} ref is present, so legacy/partial requests never write a malformed ref.
        **({"subjectClipRef": request["subject_clip_ref"]}
           if isinstance(request.get("subject_clip_ref"), dict) and request["subject_clip_ref"].get("hash") else {}),
        **({"subjectPoseRef": request["subject_pose_ref"]}
           if isinstance(request.get("subject_pose_ref"), dict) and request["subject_pose_ref"].get("hash") else {}),
        # Parity ('direct'|'reflected') as a MACHINE-READABLE field (L090) — the render mirrors ONE cell when
        # 'reflected' (opposite-handed pair, ML046). Previously only prose in tradeoffNote; the trigger-fired render
        # chain binds THIS field directly (never parses prose — a wrong parity renders the wrong-handedness mirror).
        **({"parity": str(result.get("parity"))}
           if not no_match and result.get("parity") else {}),
        "selectedFactor": selected,
        "factorMeasurements": measurements,
        "confidence": round(confidence, 6),
        "nullCalibration": {
            "minimumConfidence": float(request.get("minimum_confidence", 0.0)),
            "confidence": round(confidence, 6),
            "passed": not no_match,
            **({"noMatchReason": str(result.get("reason"))} if no_match and result.get("reason") else {}),
        },
        "sync": sync,
        "syncEvidence": sync_evidence,
        "tradeoffNote": (f"no credible partner ({result.get('reason','?')}); "
                         f"{result.get('pool_windows', 0)} windows in view family"
                         if no_match else
                         f"certified match dist {float(overall_dist):.4g} ({result.get('parity','?')} parity), "
                         f"{len(measurements)} factor measurements"),
        "createdAt": str(request["created_at"]),
    }
    if no_match and result.get("reason"):
        record["noMatchReason"] = str(result.get("reason"))
    if request.get("source_attachment_ids"):
        record["sourceAttachmentIds"] = list(request["source_attachment_ids"])
    return [record]


def main() -> int:
    """CLI: read the request JSON + the match envelope JSON, emit the records JSON. The workflow's record-write
    step consumes the emitted records. Args: --request REQ.json --match MATCH.json --out OUT.json"""
    import argparse
    ap = argparse.ArgumentParser(description="motion-match.v1 -> motion-comparison-result record")
    # arg names mirror the motion-analysis record-maker convention so the workflow compute.process step is uniform
    ap.add_argument("--request-json", required=True, help="request context JSON (comparison_id/request_id/clip ids/created_at)")
    ap.add_argument("--command-output-json", required=True, help="motion-match.v1 envelope JSON (run_match.py / orchestrate.sh output)")
    ap.add_argument("--output-json", required=True, help="output records JSON")
    a = ap.parse_args()
    request = json.loads(open(a.request_json).read())
    envelope = json.loads(open(a.command_output_json).read())
    records = records_from_match_envelope(request, envelope)
    open(a.output_json, "w").write(json.dumps({"records": records}, indent=2))
    print(f"[mc-records] wrote {len(records)} record(s) -> {a.output_json}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
