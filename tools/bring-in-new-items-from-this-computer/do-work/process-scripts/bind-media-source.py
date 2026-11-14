#!/usr/bin/env python3
"""Validate one provider-neutral media observation for downstream consumers.

The byte reader/prober remains with its canonical owner. This pure seam binds the
owner's locator and probe result to the canonical source contract; it never
branches on camera, phone, drive, cloud vendor, container, or codec.
"""

import json
import pathlib
import sys


def reject(code, detail):
    return {"state": "rejected", "code": code, "detail": detail, "production_input": None}


def bind(request):
    observation = request.get("observation") if isinstance(request.get("observation"), dict) else {}
    locator = request.get("locator") if isinstance(request.get("locator"), dict) else {}
    probe = request.get("probe") if isinstance(request.get("probe"), dict) else {}
    if request.get("cancelled") is True:
        return reject("cancelled", "the read was cancelled before a production input was admitted")
    if locator.get("availability") != "available":
        return reject("origin-unavailable", locator.get("reason") or "no readable origin is currently available")
    if not locator.get("locator_ref") or not locator.get("target") or not isinstance(locator.get("request"), dict) or not isinstance(locator.get("byte_length"), int) or locator["byte_length"] < 0:
        return reject("invalid-locator", "locator_ref and a non-negative byte_length are required")
    duration = probe.get("duration_seconds")
    if not isinstance(duration, (int, float)) or duration <= 0:
        return reject("invalid-duration", "probe duration_seconds must be positive")
    time_range = request.get("time_range") if isinstance(request.get("time_range"), dict) else {"start": 0, "end": duration}
    start, end = time_range.get("start"), time_range.get("end")
    if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or start < 0 or end <= start or end > duration:
        return reject("invalid-time-range", "time_range must be ordered, non-negative, and inside the probed duration")
    clock = request.get("clock") if isinstance(request.get("clock"), dict) else {}
    if clock.get("basis") not in ("container-timeline", "source-clock", "aligned-clock"):
        return reject("unknown-clock", "clock basis must be explicit")
    uncertainty = clock.get("uncertainty_seconds")
    if not isinstance(uncertainty, (int, float)) or uncertainty < 0:
        return reject("unknown-clock", "clock uncertainty_seconds must be a non-negative number")
    authorization = observation.get("source_authorization") if isinstance(observation.get("source_authorization"), dict) else {}
    if authorization.get("status") not in ("authorized", "declared") or not authorization.get("authorization_scope_ref"):
        return reject("unauthorized-source", "an active source authorization scope is required")
    required = ("source_identity_ref", "source_revision_ref", "correlation_ref")
    missing = [key for key in required if not observation.get(key)]
    if missing:
        return reject("incomplete-source-contract", "missing " + ", ".join(missing))
    sidecars = request.get("sidecars") if isinstance(request.get("sidecars"), list) else []
    for index, sidecar in enumerate(sidecars):
        if not isinstance(sidecar, dict) or not sidecar.get("role_ref") or not sidecar.get("source_revision_ref") or not sidecar.get("locator_ref"):
            return reject("invalid-sidecar", f"sidecars[{index}] must bind role, revision, and locator")
    return {
        "state": "usable",
        "code": None,
        "production_input": {
            "source_identity_ref": observation["source_identity_ref"],
            "source_revision_ref": observation["source_revision_ref"],
            "correlation_ref": observation["correlation_ref"],
            "authorization_scope_ref": authorization["authorization_scope_ref"],
            "locator_ref": locator["locator_ref"],
            "locator_target": locator["target"],
            # The locator REQUEST is deliberately not carried. It describes how these bytes were
            # reached on the machine that bound them, which for a local file is an absolute path
            # under someone's home, and this record is shipped composition DATA that reaches every
            # customer. A path is meaningful on exactly one machine.
            #
            # Nothing was reading it: within the tree where this vocabulary exists it was written
            # here and read nowhere, so it was write-only provenance whose only observable effect
            # was leaking a host path into a portable artifact. `locator_ref` is the portable
            # identity and is right above, so there is nothing to replace it with.
            "byte_length": locator["byte_length"],
            "media_type": probe.get("media_type"),
            "duration_seconds": duration,
            "time_range": {"start": start, "end": end},
            "clock": {"basis": clock["basis"], "uncertainty_seconds": uncertainty},
            "sidecars": sidecars,
        },
    }


def main():
    request = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    pathlib.Path(sys.argv[2]).write_text(json.dumps(bind(request), separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
