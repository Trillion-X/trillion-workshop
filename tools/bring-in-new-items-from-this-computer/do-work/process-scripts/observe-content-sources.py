#!/usr/bin/env python3
# packages/observed-content/do-work/process-scripts/observe-content-sources.py
#
# Purpose: The generic observed-content orchestrator. Reads source descriptors,
# checks per-source cursors, and emits an invocation plan for descriptor-named
# acquisition capabilities. It NEVER parses any store format, NEVER names any
# app/OS/format, and NEVER walks any store itself.
#
# Non-Negotiable Invariants:
# - Blind to formats: the only store knowledge here is "descriptor says which
#   capability observes it." No json/sqlite/http branches exist (L090).
# - O(sources) freshness: cursor comparison only; observation work is O(delta).
# - Open sets everywhere: freshness kinds, capability ids, location shapes are
#   opaque data passed through to capabilities.
# - All digests are multihash strings produced upstream; this script never
#   invents hash formats.
#
# Modes (argv[1]):
#   plan <descriptors.json> <cursors.json> <out-plan.json>
#       → which sources need observation, with their full descriptor payloads.
#   admit-validate <batch.json> <out-result.json>
#       → validate an observation batch against the canonical contract; emits
#         either {accepted: [...]} or ONE machine-readable rejection record.
#
# Security: runs under compute.process with package-scoped mounts only.
import json
import sys
import pathlib

DESCRIPTOR_REQUIRED = (
    "source_ref",
    "location",
    "access_connection_ref",
    "observer_capability_ref",
    "decoder_capability_ref",
    "projection_lens_ref",
    "identity_lens",
    "freshness_policy",
    "display_mark_ref",
)

OBSERVATION_REQUIRED = (
    "source_ref",
    "native_ref",
    "cursor",
    "observed_at",
    "content_multihash",
    "source_identity_ref",
    "source_revision_ref",
    "source_authorization",
    "source_provenance",
    "correlation_ref",
)


def read_json(path_text):
    return json.loads(pathlib.Path(path_text).read_text(encoding="utf-8"))


def write_json(path_text, value):
    pathlib.Path(path_text).write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")


def violation(path, expected, got):
    return {"violation_path": path, "expected": expected, "got": got}


def descriptor_violations(descriptor):
    found = []
    for field in DESCRIPTOR_REQUIRED:
        if field not in descriptor:
            found.append(violation(field, "present", "missing"))
    return found


def mode_plan(descriptors_path, cursors_path, out_path):
    descriptors = read_json(descriptors_path)
    cursors = read_json(cursors_path)  # { source_ref: {kind, value, advanced_at} }
    if not isinstance(descriptors, list):
        descriptors = [descriptors]
    cursor_by_source = {}
    if isinstance(cursors, dict):
        cursor_by_source = cursors
    elif isinstance(cursors, list):
        for row in cursors:
            if not isinstance(row, dict):
                continue
            subject = row.get("subject_id")
            value = row.get("value_json")
            if not subject or value is None:
                continue
            try:
                cursor_by_source[subject] = json.loads(value) if isinstance(value, str) else value
            except (TypeError, ValueError):
                continue

    plan, blocked = [], []
    for descriptor in descriptors:
        if not isinstance(descriptor, dict):
            continue
        # find-current-items rows wrap the record as {subject_id, property_id, value_json}
        if "value_json" in descriptor and "source_ref" not in descriptor:
            try:
                value = descriptor["value_json"]
                descriptor = json.loads(value) if isinstance(value, str) else value
            except (TypeError, ValueError):
                pass
            if not isinstance(descriptor, dict):
                continue
        problems = descriptor_violations(descriptor)
        if problems:
            blocked.append({
                "source_ref": descriptor.get("source_ref"),
                "state": "error",
                "violations": problems,
            })
            continue
        source_ref = descriptor["source_ref"]
        plan.append({
            "source_ref": source_ref,
            "descriptor": descriptor,
            "cursor": cursor_by_source.get(source_ref),
        })
    write_json(out_path, {"plan": plan, "blocked": blocked})
    print(f"plan sources={len(plan)} blocked={len(blocked)}")


def mode_admit_validate(batch_path, out_path):
    batch = read_json(batch_path)
    records = batch.get("observations") if isinstance(batch, dict) else None
    batch_ref = batch.get("batch_ref") if isinstance(batch, dict) else None
    source_ref = batch.get("source_ref") if isinstance(batch, dict) else None
    authorization_scope_ref = batch.get("authorization_scope_ref") if isinstance(batch, dict) else None
    if not isinstance(records, list):
        write_json(out_path, {
            "accepted": [],
            "rejection": {"batch_ref": batch_ref, "source_ref": source_ref,
                          **violation("observations", "list", type(records).__name__)},
        })
        print("rejected: observations not a list")
        return
    accepted, problems = [], []
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            problems.append(violation(f"observations[{index}]", "object", type(record).__name__))
            continue
        missing = [f for f in OBSERVATION_REQUIRED if f not in record]
        if missing:
            problems.append(violation(f"observations[{index}]", f"fields {missing}", "missing"))
            continue
        if not source_ref or record.get("source_ref") != source_ref:
            problems.append(violation(
                f"observations[{index}].source_ref", source_ref or "batch source_ref",
                record.get("source_ref"),
            ))
            continue
        if "payload" not in record and "blob_ref" not in record:
            problems.append(violation(f"observations[{index}]", "payload or blob_ref", "neither"))
            continue
        authorization = record.get("source_authorization")
        provenance = record.get("source_provenance")
        if not isinstance(authorization, dict):
            problems.append(violation(f"observations[{index}].source_authorization", "object", type(authorization).__name__))
            continue
        if authorization.get("status") not in ("authorized", "declared"):
            problems.append(violation(
                f"observations[{index}].source_authorization.status",
                "authorized or declared",
                authorization.get("status"),
            ))
            continue
        if not authorization.get("authorization_scope_ref"):
            problems.append(violation(
                f"observations[{index}].source_authorization",
                "authorization_scope_ref",
                "missing private-source boundary",
            ))
            continue
        if not authorization_scope_ref or authorization.get("authorization_scope_ref") != authorization_scope_ref:
            problems.append(violation(
                f"observations[{index}].source_authorization.authorization_scope_ref",
                authorization_scope_ref or "batch authorization_scope_ref",
                authorization.get("authorization_scope_ref"),
            ))
            continue
        if not isinstance(provenance, dict) or provenance.get("source_ref") != record.get("source_ref"):
            problems.append(violation(
                f"observations[{index}].source_provenance.source_ref",
                record.get("source_ref"),
                provenance.get("source_ref") if isinstance(provenance, dict) else type(provenance).__name__,
            ))
            continue
        if provenance.get("native_ref") != record.get("native_ref"):
            problems.append(violation(
                f"observations[{index}].source_provenance.native_ref",
                record.get("native_ref"), provenance.get("native_ref"),
            ))
            continue
        if record.get("source_revision_ref") != record.get("content_multihash"):
            problems.append(violation(
                f"observations[{index}].source_revision_ref",
                record.get("content_multihash"),
                record.get("source_revision_ref"),
            ))
            continue
        accepted.append(record)
    result = {"accepted": accepted}
    if problems:
        result["rejection"] = {"batch_ref": batch_ref, "source_ref": source_ref, "violations": problems}
    write_json(out_path, result)
    print(f"accepted={len(accepted)} violations={len(problems)}")


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: observe-content-sources.py <plan|admit-validate> ...")
    mode = sys.argv[1]
    if mode == "plan":
        mode_plan(sys.argv[2], sys.argv[3], sys.argv[4])
    elif mode == "admit-validate":
        mode_admit_validate(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(f"unknown mode: {mode}")


if __name__ == "__main__":
    main()
