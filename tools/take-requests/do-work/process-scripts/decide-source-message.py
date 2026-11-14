#!/usr/bin/env python3
"""Fail-closed decision for one source-attributed message.

The workflow supplies the candidate from a decoder, a model result from the
existing AI-records owner, and the currently read agent profile. This script
does not touch the log. It prepares one absent-current Request write and zero
or one Tasks-owner input; the workflow must complete the CAS before the Task.
"""
import json
import math
import pathlib
import sys
from datetime import datetime, timezone

DISPOSITIONS = {
    "disposition:request", "disposition:useful-finding",
    "disposition:context", "disposition:reject", "disposition:defer",
}
ACTIONABLE = {"disposition:request", "disposition:useful-finding"}
PROFILE_ID = "ai-agent-profile:founder-operator"
SAFE_WORKER_REF = "package::ai-agent-profile::agent::autonomous-safe-operator"
SAFE_WORKER_ID = "ai-agent-profile:autonomous-safe-operator"
ROUTED_WORKER_REF = "package::ai-agent-profile::agent::owner-routed-operator"
ROUTED_WORKER_ID = "ai-agent-profile:owner-routed-operator"
ASSIGNED_WORK_TOOL_REF = "package::ai-tool-catalog::tool::start-assigned-work-session"
EFFECT_CLASSES = {"private-local", "owner-routed"}


def profile_available(value):
    if isinstance(value, dict):
        if value.get("id") == PROFILE_ID and value.get("status") == "available":
            return True
        return any(profile_available(child) for child in value.values())
    if isinstance(value, list):
        return any(profile_available(child) for child in value)
    return False


def plan(request, now=None):
    candidate = request.get("candidate")
    if not isinstance(candidate, dict):
        raise ValueError("candidate is required")
    source = candidate.get("source_ref")
    native = candidate.get("native_message_ref") or candidate.get("atom_ref")
    record_ref = candidate.get("record_ref")
    if (candidate.get("origin_ref") != "human-root-session" or
            not isinstance(source, str) or not source or
            not isinstance(native, str) or not native or
            record_ref != f"request:{source}:{native}"):
        raise ValueError("candidate lacks positive human-root source identity")
    body = candidate.get("text")
    if not isinstance(body, str) or not body.strip():
        raise ValueError("candidate text is required")

    existing = request.get("existing_request")
    if existing is not None:
        if (not isinstance(existing, dict) or existing.get("record_ref") != record_ref or
                existing.get("source_ref") != source or
                existing.get("native_message_ref") != candidate.get("native_message_ref") or
                existing.get("atom_ref") != candidate.get("atom_ref") or
                existing.get("content_revision") != candidate.get("content_revision")):
            raise ValueError("existing Request conflicts with source identity")
    existing_task = request.get("existing_task")
    if existing_task is not None and (
            not isinstance(existing_task, dict) or
            existing_task.get("task_id") != record_ref or
            existing_task.get("task_number") != record_ref):
        raise ValueError("existing Task conflicts with source identity")
    existing_claim = request.get("existing_claim")
    claim_ref = f"{record_ref}:execution-claim"
    if existing_claim is not None and (
            not isinstance(existing_claim, dict) or
            existing_claim.get("claim_ref") != claim_ref or
            existing_claim.get("task_ref") != record_ref or
            existing_claim.get("source_ref") != source):
        raise ValueError("existing execution claim conflicts with source identity")
    existing_session = request.get("existing_session")
    if existing_session is not None and (
            not isinstance(existing_session, dict) or
            existing_session.get("task_ref") != record_ref):
        raise ValueError("existing execution session conflicts with task identity")

    result = request.get("model_result")
    items = result.get("items") if isinstance(result, dict) and result.get("status") == "completed" else None
    decision = items[0] if isinstance(items, list) and len(items) == 1 and isinstance(items[0], dict) else {}
    disposition = decision.get("disposition_ref")
    confidence = decision.get("confidence")
    reason = decision.get("reason")
    effect_class = decision.get("effect_class")
    if effect_class not in EFFECT_CLASSES:
        effect_class = "owner-routed"
    if (disposition not in DISPOSITIONS or isinstance(confidence, bool) or
            not isinstance(confidence, (int, float)) or not math.isfinite(confidence) or
            confidence < 0.65 or confidence > 1 or
            not isinstance(reason, str) or not reason.strip()):
        disposition, reason = "disposition:defer", "The request decision is not reliable yet."

    owner = PROFILE_ID if profile_available(request.get("owner_readback")) else None
    if disposition in ACTIONABLE and owner is None:
        disposition, reason = "disposition:defer", "The current work owner is unavailable."
    if len(body) > 65536 and disposition in ACTIONABLE:
        disposition, reason = "disposition:defer", "The message needs a bounded source view."

    # Once admitted, the Request is authoritative. A later model response may
    # differ, but it must not make a second decision for the same message.
    if existing is not None:
        disposition = existing.get("disposition_ref")
        reason = existing.get("reason")
        if disposition not in DISPOSITIONS or not isinstance(reason, str):
            raise ValueError("existing Request has no valid decision")
        if disposition in ACTIONABLE and existing.get("owner_ref") != PROFILE_ID:
            raise ValueError("existing Request has an unexpected owner")
        owner = existing.get("owner_ref") if disposition in ACTIONABLE else None
        effect_class = existing.get("effect_class", "owner-routed")
        if effect_class not in EFFECT_CLASSES:
            raise ValueError("existing Request has an invalid effect class")

    # A missing model answer or owner is transient. Writing a permanent
    # absent-current Request for it would prevent a later successful retry.
    if disposition == "disposition:defer":
        return {"writes": [], "tasks": [], "claim_writes": [], "start": None,
                "record_ref": record_ref,
                "disposition_ref": disposition, "reason": reason}

    record = {
        "kind": "request-intake.source-message-decision",
        "record_ref": record_ref,
        "source_ref": source,
        "native_message_ref": candidate.get("native_message_ref"),
        "atom_ref": candidate.get("atom_ref"),
        "content_revision": candidate.get("content_revision"),
        "at": candidate.get("at"),
        "disposition_ref": disposition,
        "reason": reason,
        "owner_ref": owner if disposition in ACTIONABLE else None,
        "effect_class": effect_class if disposition in ACTIONABLE else None,
        "task_ref": record_ref if disposition in ACTIONABLE else None,
        "text": body[:65536],
    }
    writes = [] if existing is not None else [{
        "address_label": record_ref,
        "address_mode": "identity_text",
        "path_labels": ["current-item", "request-intake-request"],
        "payload": record,
        "expected_current": {"payload_hash_base64": None},
    }]
    checks = decision.get("acceptance_criteria")
    checks = [item.strip() for item in checks if isinstance(item, str) and item.strip()] if isinstance(checks, list) else []
    tasks = []
    if disposition in ACTIONABLE and existing_task is None:
        tasks.append({
            "task_id": record_ref,
            "task_number": record_ref,
            "project_id": "request-intake",
            "title": body.strip()[:240],
            "objective": body,
            "acceptance_criteria": checks or ["The requested outcome is verified in its real destination."],
            "status": "open",
            "priority": "HIGH",
            "assigned_to": owner,
            "assignee": owner,
            "blocked_by": [],
            "claimed_by": [],
            "attachments": [],
            "proof_links": [candidate.get("atom_ref")],
            "created_date": candidate.get("at"),
            "updated_date": candidate.get("at"),
        })
    claim_writes = []
    start = None
    if disposition in ACTIONABLE and existing_claim is None:
        claim_time = now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        work_source_ref = f"{record_ref}:assigned-work-source"
        safe = effect_class == "private-local"
        worker_id = SAFE_WORKER_ID if safe else ROUTED_WORKER_ID
        claim = {
            "kind": "request-intake.task-execution-claim",
            "claim_ref": claim_ref,
            "task_ref": record_ref,
            "source_ref": source,
            "native_message_ref": candidate.get("native_message_ref"),
            "effect_class": effect_class,
            "status": "pending-start",
            "claimed_at": claim_time,
            "owner_ref": worker_id,
            "route_note": None,
            "work_source_ref": work_source_ref,
            "start_action_ref": "action:process-session:start-authorized-assigned-work-session",
        }
        claim_writes.append({
            "address_label": claim_ref,
            "address_mode": "identity_text",
            "path_labels": ["current-item", "published-record"],
            "payload": claim,
            "expected_current": {"payload_hash_base64": None},
        })
        work_source = {
            "kind": "assigned-work-source",
            "owner": "request-intake",
            "task_ref": record_ref,
            "title": body.strip()[:240],
            "objective": body,
            "acceptance_criteria": checks or ["The requested outcome is verified in its real destination."],
            "assignedTo": [worker_id],
            "estimated_cost": 0,
            "effect_boundary": ("Reversible private local work only; stop at any external, credential, spend, publication, or production effect." if safe else
                                "Use declared effect owners for external actions. Verify exact targets, preserve privacy and independent rights, and read back real outcomes."),
            "state": "ready",
        }
        claim_writes.append({
            "address_label": work_source_ref,
            "address_mode": "identity_text",
            "path_labels": ["current-item", "published-record"],
            "payload": work_source,
            "expected_current": {"payload_hash_base64": None},
        })
    if (disposition in ACTIONABLE and
            existing_session is None and
            (existing_claim is None or existing_claim.get("status") == "pending-start")):
        start = {
            "sourceRecordRef": f"{record_ref}:assigned-work-source",
            "workerRecordRef": SAFE_WORKER_REF if effect_class == "private-local" else ROUTED_WORKER_REF,
            "workerRecordAddressMode": "label_hash",
            "toolRecordRef": ASSIGNED_WORK_TOOL_REF,
        }
    return {"writes": writes, "tasks": tasks, "claim_writes": claim_writes,
            "start": start, "claim_ref": claim_ref,
            "record_ref": record_ref, "disposition_ref": disposition,
            "effect_class": effect_class}


def main():
    if len(sys.argv) == 9:
        names = ("candidate", "model_result", "owner_readback", "existing_request", "existing_task", "existing_claim", "existing_session")
        request = {name: json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
                   for name, path in zip(names, sys.argv[1:8])}
        out_path = sys.argv[8]
    else:
        request = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
        out_path = sys.argv[2]
    pathlib.Path(out_path).write_text(json.dumps(plan(request), separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
