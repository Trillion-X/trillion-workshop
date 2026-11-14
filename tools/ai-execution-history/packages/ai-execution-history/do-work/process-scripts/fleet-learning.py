#!/usr/bin/env python3
"""Deterministic fleet-learning planning over privacy-safe execution evidence.

This module owns no provider, failure signature, package, user, path, or receiver.
Source grants, signal rules, repair candidates, and installation capabilities are
DATA.  The output is a bounded plan for the existing work-control, instruction,
package, and convergence owners; it performs no external effect itself.
"""
import argparse
from datetime import datetime
import hashlib
import json
import math
import re
import sys


PRIVATE_KEYS = {
    "content", "messages", "prompt", "raw", "raw_text", "text", "transcript",
    "source_artifact_refs", "path", "root", "glob", "credential", "secret",
}

RECORD_KIND_TO_COLLECTION = {
    "fleet-learning-source-descriptor": "source_descriptors",
    "permission_lease": "permission_leases",
    "ai-execution-run": "runs",
    "fleet-learning-failure-signal-rule": "failure_signal_rules",
    "fleet-learning-repair-candidate": "repair_candidates",
    "fleet-learning-installation": "installations",
    "fleet-learning-application-observation": "application_observations",
    "fleet-learning-outcome-observation": "outcome_observations",
    "fleet-learning-analysis-policy": "analysis_policies",
    "fleet-learning-local-provider": "provider_records",
    "ai-work-operation": "work_operations",
    "saved-work-result-learning-binding": "saved_result_learning_bindings",
    "fleet-learning-summary": "learning_summaries",
}

def expand_record_feed(request):
    """Split a current-record feed into the evaluator's named DATA collections."""
    if isinstance(request, list):
        request = {"records": request}
    expanded = dict(request)
    for collection in RECORD_KIND_TO_COLLECTION.values():
        if collection in expanded:
            expanded[collection] = list(expanded[collection])
    for row in request.get("records", []):
        if not isinstance(row, dict):
            continue
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else row
        collection = RECORD_KIND_TO_COLLECTION.get(payload.get("kind"))
        if collection:
            expanded.setdefault(collection, []).append(payload)
    return expanded


def token(value):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", str(value)).strip("-")


def get_path(value, path):
    current = value
    for key in path or []:
        if isinstance(current, dict):
            current = current.get(key)
        else:
            return None
    return current


def compare(actual, operator, expected):
    if operator == "eq":
        return actual == expected
    if operator == "neq":
        return actual != expected
    if operator == "gte":
        return isinstance(actual, (int, float)) and actual >= expected
    if operator == "lte":
        return isinstance(actual, (int, float)) and actual <= expected
    if operator == "present":
        return actual is not None
    if operator == "absent":
        return actual is None
    if operator == "contains":
        return isinstance(actual, list) and expected in actual
    if operator == "in":
        return isinstance(expected, list) and actual in expected
    return False


def matches(record, predicates):
    return all(compare(get_path(record, item.get("path")), item.get("op"), item.get("value"))
               for item in predicates or [])


def contains_private_material(value, key=None):
    if key in PRIVATE_KEYS:
        return True
    if isinstance(value, dict):
        return any(contains_private_material(item, str(name).lower())
                   for name, item in value.items())
    if isinstance(value, list):
        return any(contains_private_material(item) for item in value)
    return False


def unambiguous_records(rows, identity_fields):
    """Resolve current identities without granting authority by arrival order.

    Identical delivery is idempotent. Conflicting current rows have no winner;
    temporal/revision arbitration belongs to the upstream record owner.
    """
    indexed, conflicts = {}, set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        identity = tuple(row.get(field) for field in identity_fields)
        if not all(isinstance(value, str) and value for value in identity):
            continue
        if (identity in indexed and json.dumps(indexed[identity], sort_keys=True)
                != json.dumps(row, sort_keys=True)):
            conflicts.add(identity)
        else:
            indexed.setdefault(identity, row)
    for identity in conflicts:
        indexed.pop(identity, None)
    return indexed, conflicts


def authorization_time_ms(request):
    value = request.get("authorization_time_ms") if isinstance(request, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991 else None


def permission_is_current(lease, now_ms):
    expires_at = lease.get("expires_at") if isinstance(lease, dict) else None
    if expires_at is None:
        return True
    if now_ms is None or not isinstance(expires_at, str) or not expires_at.strip() or expires_at != expires_at.strip():
        return False
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    if expiry.tzinfo is None:
        return False
    return now_ms < int(expiry.timestamp() * 1000)


def active_permission_context(lease, required_operations, now_ms=None):
    """Return owner-bounded context from the canonical permission note only.

    The context identifies records; it never grants an operation. The canonical
    permission owner separately proves the exact allowed operation list.
    """
    if (not isinstance(lease, dict) or lease.get("kind") != "permission_lease"
            or lease.get("revoked") is not False
            or not isinstance(lease.get("allowed_by_decision_proof"), str)
            or not lease["allowed_by_decision_proof"].strip()
            or not isinstance(lease.get("allowed_operation_refs"), list)
            or not all(isinstance(item, str) for item in lease["allowed_operation_refs"])
            or not all(item in lease["allowed_operation_refs"] for item in required_operations)
            or not permission_is_current(lease, now_ms)
            or not isinstance(lease.get("bound_context"), dict)):
        return None
    return lease["bound_context"]


def plan_discovery(request):
    """Select every current authorized installation-local session source."""
    request = expand_record_feed(request)
    lease_rows, lease_conflicts = unambiguous_records(
        request.get("permission_leases", []), ("lease_ref",))
    leases = {key[0]: row for key, row in lease_rows.items()}
    descriptors, descriptor_conflicts = unambiguous_records(
        request.get("source_descriptors", []), ("installation_ref", "source_ref"))
    providers_required = "provider_records" in request
    providers, provider_conflicts = {}, set()
    for row in request.get("provider_records", []):
        if not isinstance(row, dict):
            continue
        source_ref = row.get("subject_id")
        try:
            provider = json.loads(row.get("value_json"))
        except (TypeError, ValueError):
            provider = None
        if (row.get("kind") != "fleet-learning-local-provider"
                or row.get("table") != "attribute_fact"
                or row.get("property_id") != "prop:observed_content:source_descriptor"
                or row.get("type_id") != "type:observed_content"
                or not isinstance(source_ref, str) or not source_ref
                or not isinstance(provider, dict) or provider.get("source_ref") != source_ref
                or not isinstance(provider.get("provider_revision"), str)
                or not provider["provider_revision"]):
            continue
        identity = (source_ref,)
        if (identity in providers and json.dumps(providers[identity], sort_keys=True) \
                != json.dumps(row, sort_keys=True)):
            provider_conflicts.add(identity)
            providers.pop(identity, None)
        elif identity not in provider_conflicts:
            providers[identity] = row
    selected, rejections = [], []
    now_ms = authorization_time_ms(request)
    rejections.extend({"source_ref": source, "installation_ref": installation,
                       "state": "rejected", "reason": "source-descriptor-ambiguous"}
                      for installation, source in sorted(descriptor_conflicts))
    invalid_descriptors = [row for row in request.get("source_descriptors", [])
                           if isinstance(row, dict) and not all(
                               isinstance(row.get(field), str) and row.get(field)
                               for field in ("installation_ref", "source_ref"))]
    for descriptor in [*descriptors.values(), *invalid_descriptors]:
        source_ref = descriptor.get("source_ref")
        installation_ref = descriptor.get("installation_ref")
        lease_ref = descriptor.get("permission_lease_ref")
        lease = leases.get(lease_ref) if isinstance(lease_ref, str) else None
        reason = None
        provider_reason = None
        if providers_required and (source_ref,) in provider_conflicts:
            provider_reason = "source-provider-ambiguous"
        elif providers_required and (source_ref,) not in providers:
            provider_reason = "source-provider-absent"
        elif providers_required:
            provider_row = providers[(source_ref,)]
            provider = json.loads(provider_row["value_json"])
            expected_ref = ("attribute_fact|%s|prop:observed_content:source_descriptor|"
                            "type:observed_content") % source_ref
            if descriptor.get("provider_record_ref") != expected_ref:
                provider_reason = "source-provider-mismatch"
            elif descriptor.get("provider_revision") != provider.get("provider_revision"):
                provider_reason = "source-provider-revision-mismatch"
        if not all(isinstance(value, str) and value for value in (
                source_ref, installation_ref, descriptor.get("provider_record_ref"),
                descriptor.get("provider_revision"))):
            reason = "invalid-source-descriptor"
        elif provider_reason:
            reason = provider_reason
        elif isinstance(lease_ref, str) and (lease_ref,) in lease_conflicts:
            reason = "permission-lease-ambiguous"
        elif not lease:
            reason = "permission-lease-absent"
        elif lease.get("kind") != "permission_lease" or lease.get("revoked") is not False:
            reason = "permission-revoked"
        elif not permission_is_current(lease, now_ms):
            reason = "permission-expired"
        elif (not isinstance(lease.get("allowed_operation_refs"), list)
              or "analyze-local-session" not in lease["allowed_operation_refs"]
              or not isinstance(lease.get("allowed_by_decision_proof"), str)
              or not lease["allowed_by_decision_proof"].strip()):
            reason = "permission-scope-missing"
        elif not isinstance(lease.get("bound_context"), dict):
            reason = "permission-context-absent"
        elif lease["bound_context"].get("installation_ref") != installation_ref:
            reason = "permission-installation-mismatch"
        elif lease["bound_context"].get("source_ref") != source_ref:
            reason = "permission-source-mismatch"
        elif lease["bound_context"].get("provider_record_ref") != descriptor.get("provider_record_ref"):
            reason = "permission-provider-mismatch"
        elif lease["bound_context"].get("provider_revision") != descriptor.get("provider_revision"):
            reason = "permission-provider-revision-mismatch"
        elif (not isinstance(lease.get("subject_ref"), str) or not lease.get("subject_ref")
              or lease["bound_context"].get("user_ref") != lease.get("subject_ref")):
            reason = "permission-user-absent"
        elif descriptor.get("user_ref") and descriptor["user_ref"] != lease["subject_ref"]:
            reason = "permission-user-mismatch"
        if reason:
            rejections.append({"source_ref": source_ref, "installation_ref": installation_ref,
                               "state": "rejected", "reason": reason})
            continue
        selected.append({
            **descriptor,
            "permission": {"state": "active", "operations": ["analyze-local-session"]},
            "user_ref": lease.get("subject_ref"),
        })
    selected.sort(key=lambda item: (str(item.get("installation_ref")), str(item.get("source_ref"))))
    installation_count = len({x["installation_ref"] for x in selected})
    records = [{
        "address_label": "package::ai-execution-history::fleet-discovery::current",
        "payload": {"kind": "fleet-learning-discovery-summary",
                    "id": "fleet-learning-discovery-summary:current",
                    "authorized_source_count": len(selected),
                    "discovered_installation_count": installation_count,
                    "rejection_count": len(rejections)},
    }]
    records.extend({
        "address_label": "package::ai-execution-history::fleet-discovery-rejection::%s::%s" % (
            token(item.get("installation_ref")), token(item.get("source_ref"))),
        "payload": {"kind": "fleet-learning-discovery-rejection", **item},
    } for item in rejections)
    return {"sources": selected, "rejections": rejections, "records": records,
            "discovered_installation_count": installation_count}


def trusted_runs(request):
    admitted, rejected = [], []
    current_authorizations = None
    if "source_descriptors" in request:
        current_authorizations = {(row["installation_ref"], row["source_ref"])
                                  for row in plan_discovery(request)["sources"]}
    rows, conflicts = unambiguous_records(request.get("runs", []), ("id",))
    rejected.extend({"run_ref": None, "state": "rejected",
                     "reason": "execution-evidence-identity-invalid"}
                    for row in request.get("runs", [])
                    if not isinstance(row, dict) or not isinstance(row.get("id"), str)
                    or not row.get("id"))
    rejected.extend({"run_ref": identity[0], "state": "rejected",
                     "reason": "execution-evidence-ambiguous"}
                    for identity in sorted(conflicts))
    for run in rows.values():
        trust = run.get("trust") if isinstance(run.get("trust"), dict) else {}
        provenance = run.get("provenance") if isinstance(run.get("provenance"), dict) else {}
        if (trust.get("state") != "trusted"
                or not isinstance(trust.get("score"), (int, float))
                or isinstance(trust.get("score"), bool)
                or not math.isfinite(trust.get("score"))
                or not 0 <= trust.get("score") <= 1):
            rejected.append({"run_ref": run.get("id"), "state": "rejected",
                             "reason": "poisoned-or-untrusted-evidence"})
        elif provenance.get("source_permission_state") != "active":
            rejected.append({"run_ref": run.get("id"), "state": "rejected",
                             "reason": "source-permission-not-active"})
        elif (current_authorizations is not None
              and (not all(isinstance(provenance.get(field), str)
                           for field in ("installation_ref", "source_ref"))
                   or (provenance.get("installation_ref"), provenance.get("source_ref"))
                   not in current_authorizations)):
            rejected.append({"run_ref": run.get("id"), "state": "rejected",
                             "reason": "source-permission-not-current"})
        else:
            admitted.append(run)
    return admitted, rejected


def correlation_map(value):
    rows = value.get("correlation_refs") if isinstance(value, dict) else None
    if not isinstance(rows, list):
        return {}
    mapped = {}
    for row in rows:
        if (not isinstance(row, dict) or not privacy_safe_ref(row.get("role"))
                or not privacy_safe_ref(row.get("ref"))
                or row["role"] in mapped):
            return {}
        mapped[row["role"]] = row["ref"]
    return mapped


def complete_outcome_correlation(value, contract):
    mapped = correlation_map(value)
    return mapped if all(mapped.get(role) for role in contract["correlation_roles"]) else None


def complete_real_outcome_proof(value, contract):
    """Validate the selected owner's evidence contract, independent of job type."""
    proof = get_path(value, contract["proof_path"])
    if not isinstance(proof, dict) or contains_private_material(proof):
        return None
    for path in contract["required_ref_paths"]:
        if not privacy_safe_ref(get_path(proof, path)):
            return None
    if not matches(proof, contract["predicates"]):
        return None
    return json.loads(json.dumps(proof, sort_keys=True))


def outcome_contract(rule, candidate):
    """The rule owner selects requirements; a candidate cannot lower them.

    Pin the entire contract, not its mutable label. Missing/changed contracts
    stop evaluation visibly and require a reviewed forward candidate revision.
    """
    contract = rule.get("outcome_contract") if isinstance(rule, dict) else None
    required = {"proof_path", "correlation_roles", "required_ref_paths", "predicates",
                "correlation_bindings", "distinct_proof_paths", "failure_reasons"}
    if not isinstance(contract, dict) or set(contract) != required:
        return None
    def path_ok(path):
        return (isinstance(path, list) and 0 < len(path) <= 16
                and all(isinstance(part, str) and privacy_safe_ref(part)
                        and part.lower() not in PRIVATE_KEYS for part in path))
    roles = contract["correlation_roles"]
    refs = contract["required_ref_paths"]
    distinct = contract["distinct_proof_paths"]
    predicates = contract["predicates"]
    bindings = contract["correlation_bindings"]
    reasons = contract["failure_reasons"]
    if (not path_ok(contract["proof_path"])
            or contract["proof_path"][0] != "real_outcome_proof"
            or not isinstance(roles, list) or not 1 <= len(roles) <= 16
            or not all(privacy_safe_ref(role) for role in roles)
            or len(set(roles)) != len(roles)
            or not isinstance(refs, list) or not 1 <= len(refs) <= 64
            or not all(path_ok(path) for path in refs)
            or not isinstance(distinct, list) or not 1 <= len(distinct) <= 16
            or not all(path in refs for path in distinct)
            or not isinstance(predicates, list) or not 1 <= len(predicates) <= 64
            or not all(isinstance(row, dict) and set(row) == {"path", "op", "value"}
                       and path_ok(row["path"]) and row["op"] == "eq"
                       and privacy_safe_cluster_value(row["value"]) is not None
                       for row in predicates)
            or not isinstance(bindings, list) or not 1 <= len(bindings) <= 16
            or not all(isinstance(row, dict) and set(row) == {"path", "role"}
                       and row["path"] in refs and row["role"] in roles
                       for row in bindings)
            or not isinstance(reasons, dict)
            or set(reasons) != {"absent", "mismatch", "correlation_mismatch"}
            or not all(privacy_safe_ref(reason) for reason in reasons.values())):
        return None
    if candidate.get("outcome_contract_ref") != stable_ref("fleet-outcome-contract", contract):
        return None
    return contract


def proof_matches_correlation(proof, correlation, contract):
    return all(get_path(proof, binding["path"]) == correlation.get(binding["role"])
               for binding in contract["correlation_bindings"])


def parse_observed_at(value):
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is not None else None
    except ValueError:
        return None


def trusted_observation(row, installation_ref, min_trust_score, request):
    trust = row.get("trust") if isinstance(row, dict) else None
    provenance = row.get("provenance") if isinstance(row, dict) else None
    if "source_descriptors" in request:
        authorized = {(source["installation_ref"], source["source_ref"])
                      for source in plan_discovery(request)["sources"]}
        if (not isinstance(provenance, dict)
                or not isinstance(provenance.get("source_ref"), str)
                or (installation_ref, provenance["source_ref"]) not in authorized):
            return False
    return (isinstance(trust, dict) and trust.get("state") == "trusted"
            and isinstance(trust.get("score"), (int, float))
            and not isinstance(trust.get("score"), bool)
            and math.isfinite(trust.get("score"))
            and min_trust_score <= trust.get("score") <= 1
            and isinstance(provenance, dict)
            and provenance.get("source_permission_state") == "active"
            and provenance.get("installation_ref") == installation_ref)


def privacy_safe_outcome_value(value):
    return isinstance(value, bool) or (isinstance(value, (int, float))
                                       and not isinstance(value, bool)
                                       and math.isfinite(value))


def privacy_safe_cluster_value(value):
    """Allow only bounded normalized facts into a transferable cluster key."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value
    if isinstance(value, str) and value == value.strip() and 0 < len(value) <= 128:
        return value if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*", value) else None
    return None


def privacy_safe_ref(value):
    return (isinstance(value, str) and value == value.strip() and 0 < len(value) <= 256
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*", value) is not None)


def privacy_safe_transfer_payload(value):
    """Transfer only opaque refs; prose and source material stay installation-local."""
    if not isinstance(value, dict):
        return False
    for key, item in value.items():
        if key.endswith("_ref"):
            if not privacy_safe_ref(item):
                return False
        elif key.endswith("_refs"):
            if not isinstance(item, list) or not all(privacy_safe_ref(ref) for ref in item):
                return False
        else:
            return False
    return True


def stable_ref(prefix, value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "%s:%s" % (prefix, hashlib.sha256(encoded).hexdigest())


def plan_failure_analysis(request, runs, rules):
    """Cluster uncovered trusted failures and submit deterministic work-control objectives.

    Policies are DATA. The planner exports only normalized scalar dimensions and
    opaque run/installation refs; source bytes, paths, prompts and messages never
    enter the objective. Candidate suppression is exact-evidence-frontier based:
    identical clock ticks are idempotent while new trusted failures reopen work.
    """
    del rules
    candidate_analysis_refs = {candidate.get("analysis_ref")
                               for candidate in request.get("repair_candidates", [])
                               if candidate.get("analysis_ref")}
    requests, clusters, rejections = [], [], []
    policies, policy_conflicts = unambiguous_records(
        request.get("analysis_policies", []), ("policy_ref",))
    rejections.extend({"policy_ref": key[0], "state": "rejected",
                       "reason": "analysis-policy-ambiguous"}
                      for key in sorted(policy_conflicts))
    for policy in policies.values():
        policy_ref = policy.get("policy_ref")
        if "status" in policy and policy["status"] != "active":
            rejections.append({"policy_ref": policy_ref, "state": "rejected",
                               "reason": "analysis-policy-not-active"})
            continue
        action_ref = policy.get("analysis_action_ref")
        paths = policy.get("cluster_paths") or []
        min_sessions = policy.get("min_distinct_sessions", 1)
        min_installations = policy.get("min_distinct_installations", 1)
        min_trust = policy.get("min_trust_score", 0)
        max_evidence_refs = policy.get("max_evidence_refs", 64)
        if (not policy_ref or action_ref != "action:write-fleet-learning-record"
                or not isinstance(paths, list) or not paths or len(paths) > 8
                or not isinstance(min_sessions, int) or isinstance(min_sessions, bool)
                or min_sessions < 1
                or not isinstance(min_installations, int) or isinstance(min_installations, bool)
                or min_installations < 1
                or not isinstance(min_trust, (int, float)) or isinstance(min_trust, bool)
                or not math.isfinite(min_trust) or not 0 <= min_trust <= 1
                or not isinstance(max_evidence_refs, int)
                or isinstance(max_evidence_refs, bool)
                or not 1 <= max_evidence_refs <= 256):
            rejections.append({"policy_ref": policy_ref, "state": "rejected",
                               "reason": "analysis-policy-invalid"})
            continue
        grouped = {}
        for run in runs:
            run_ref = run.get("id")
            if not run_ref or not matches(run, policy.get("failure_predicates")):
                continue
            dimensions = []
            invalid = False
            for path in paths:
                if (not isinstance(path, list) or not path
                        or any(str(part).lower() in PRIVATE_KEYS for part in path)):
                    invalid = True
                    break
                value = get_path(run, path)
                if value is None:
                    continue
                safe_value = privacy_safe_cluster_value(value)
                if safe_value is None:
                    invalid = True
                    break
                dimensions.append({"path": path, "value": safe_value})
            if invalid:
                rejections.append({"policy_ref": policy_ref, "run_ref": run_ref,
                                   "state": "rejected",
                                   "reason": "private-or-unsafe-cluster-dimension"})
                continue
            if not dimensions:
                rejections.append({"policy_ref": policy_ref, "run_ref": run_ref,
                                   "state": "rejected", "reason": "cluster-dimension-absent"})
                continue
            key = json.dumps(dimensions, sort_keys=True, separators=(",", ":"))
            grouped.setdefault(key, []).append(run)
        for key, matched in grouped.items():
            all_run_refs = sorted({row.get("id") for row in matched if row.get("id")})
            run_refs = all_run_refs[-max_evidence_refs:]
            installation_refs = sorted({(row.get("provenance") or {}).get("installation_ref")
                                        for row in matched
                                        if (row.get("provenance") or {}).get("installation_ref")})
            dimensions = json.loads(key)
            analysis_ref = stable_ref("fleet-learning-analysis", {
                "policy_ref": policy_ref, "dimensions": dimensions,
                **({"policy_binding_ref": stable_ref("fleet-analysis-policy", policy)}
                   if "worker_binding" in policy else {}),
                "evidence_frontier": {"run_refs": run_refs,
                                      "matched_session_count": len(all_run_refs)},
            })
            if len(all_run_refs) < min_sessions:
                state, reason = "observed", "insufficient-distinct-sessions"
            elif len(installation_refs) < min_installations:
                state, reason = "observed", "insufficient-distinct-installations"
            elif any((row.get("trust") or {}).get("score", 0)
                     < min_trust for row in matched):
                state, reason = "rejected", "trust-threshold-not-met"
            elif analysis_ref in candidate_analysis_refs:
                state, reason = "candidate-present", None
            else:
                state, reason = "analysis-requested", None
            cluster = {
                "analysis_ref": analysis_ref, "policy_ref": policy_ref,
                "state": state, "dimensions": dimensions,
                "run_refs": run_refs, "installation_refs": installation_refs,
                "matched_session_count": len(all_run_refs),
                "matched_installation_count": len(installation_refs),
                **({"reason": reason} if reason else {}),
            }
            clusters.append(cluster)
            if state != "analysis-requested":
                continue
            operation_id = "operation:%s" % analysis_ref
            requests.append({
                "analysis_ref": analysis_ref,
                "definition_id": action_ref,
                "input": {"record": {
                    "address_label": "package::ai-execution-history::operation::%s" % analysis_ref,
                    "payload": {
                        "kind": "ai-work-operation", "id": operation_id,
                        "objective_ref": analysis_ref,
                        "objective": "Analyze this privacy-safe recurring failure cluster, locate the deepest canonical owner, sweep every caller and sibling, implement and hostile-test the complete repair, then submit a reviewed fleet-learning-repair-candidate through action:materialize-fleet-learning-repair-candidate.",
                        "evidence_refs": run_refs,
                        "installation_refs": installation_refs,
                        "cluster_dimensions": dimensions,
                        "required_result_action_ref": "action:materialize-fleet-learning-repair-candidate",
                    }}},
            })
    clusters.sort(key=lambda item: item["analysis_ref"])
    requests.sort(key=lambda item: item["analysis_ref"])
    return requests, clusters, rejections


def plan_authorized_analysis_dispatch(request, analysis_requests, clusters):
    """Continue saved work through process-session, never launch an uncommitted row.

    Worker selection is current policy DATA, not consent. The process-session
    owner re-reads source/profile/tool and proves guards, permission and budget.
    Its reservation fence, not an extra Fleet job store, owns launch idempotency.
    """
    policies, _ = unambiguous_records(request.get("analysis_policies", []), ("policy_ref",))
    operations, conflicts = unambiguous_records(request.get("work_operations", []), ("id",))
    by_analysis = {row["analysis_ref"]: row for row in clusters}
    submissions, launches = [], []
    for planned in analysis_requests:
        cluster = by_analysis[planned["analysis_ref"]]
        policy = policies.get((cluster["policy_ref"],), {})
        binding = policy.get("worker_binding")
        operation = planned["input"]["record"]["payload"]
        identity = (operation["id"],)
        def saved_matches():
            return json.dumps(operations.get(identity), sort_keys=True) == json.dumps(operation, sort_keys=True)
        if binding is None:
            cluster["reason"] = "authorized-worker-binding-absent"
            if identity in conflicts or (identity in operations and not saved_matches()):
                cluster.update(state="rejected", reason="saved-analysis-operation-conflict")
            elif identity in operations:
                cluster["state"] = "analysis-awaiting-worker"
            else:
                submissions.append(planned)
            continue
        if isinstance(binding, dict) and binding.get("state") != "active":
            cluster.update(state="rejected", reason="authorized-worker-binding-not-active")
            continue
        if (policy.get("status") != "active"
                or not privacy_safe_ref(policy.get("policy_record_ref"))):
            cluster.update(state="rejected", reason="worker-policy-current-owner-reference-absent")
            continue
        required = {"state", "worker_ref", "worker_record_ref", "tool_record_ref",
                    "estimated_cost", "effect_boundary"}
        valid = (isinstance(binding, dict) and set(binding) == required
                 and all(privacy_safe_ref(binding.get(field))
                         for field in required - {"estimated_cost"})
                 and binding["worker_record_ref"].startswith("package::ai-agent-profile::")
                 and binding["tool_record_ref"].startswith("package::ai-tool-catalog::")
                 and isinstance(binding["estimated_cost"], int)
                 and not isinstance(binding["estimated_cost"], bool)
                 and 0 <= binding["estimated_cost"] <= 9007199254740991)
        if not valid:
            cluster.update(state="rejected", reason="authorized-worker-binding-invalid")
            continue
        operation.update({
            "owner": "ai-execution-history", "state": "ready",
            "title": "Analyze recurring failures",
            "assignedTo": [binding["worker_ref"]],
            "estimated_cost": binding["estimated_cost"],
            "effect_boundary": binding["effect_boundary"],
            "execution_preconditions": [
                {"record_ref": policy["policy_record_ref"], "path": [],
                 "expected": json.loads(json.dumps(policy))},
            ],
            "attachments": [{"kind": "log-ref", "ref": ref}
                            for ref in operation["evidence_refs"]],
            "proof_links": [{"kind": "action-ref", "ref": operation["required_result_action_ref"]}],
            "acceptance_criteria": [
                "Read only the authorized evidence references and identify the shared cause.",
                "Repair the owning implementation, check affected callers, and run hostile tests.",
                "Submit a reviewed repair candidate with private source material excluded.",
            ],
        })
        saved = operations.get(identity)
        if identity in conflicts or (saved is not None and not saved_matches()):
            cluster.update(state="rejected", reason="saved-analysis-operation-conflict")
            continue
        if saved is None:
            cluster.update(state="analysis-requested", reason="assigned-operation-not-yet-saved")
            submissions.append(planned)
            continue
        cluster.update(state="worker-start-requested")
        cluster.pop("reason", None)
        launches.append({
            "analysis_ref": planned["analysis_ref"],
            "definition_id": "action:process-session:start-authorized-assigned-work-session",
            "input": {
                "sourceRecordRef": "package::ai-execution-history::operation::%s" % planned["analysis_ref"],
                "workerRecordRef": binding["worker_record_ref"],
                "toolRecordRef": binding["tool_record_ref"],
            },
        })
    return submissions, launches


def validate_repair_candidate(request):
    candidate = request.get("candidate") if isinstance(request, dict) else None
    if not isinstance(candidate, dict):
        raise ValueError("candidate is required")
    required = ("candidate_ref", "analysis_ref", "rule_ref", "owner_ref", "change_ref",
                "repair_action_ref", "convergence_owner_ref", "convergence_action_ref",
                "applicability_ref", "outcome_contract_ref")
    missing = [name for name in required if not candidate.get(name)]
    if missing:
        raise ValueError("candidate missing required fields: %s" % ", ".join(missing))
    repair_input = candidate.get("repair_input") or {}
    if candidate.get("repair_action_ref") == "action:write-fleet-learning-record":
        if (((repair_input.get("record") or {}).get("payload") or {}).get("change_ref")
                != candidate.get("change_ref")
                or ((repair_input.get("record") or {}).get("payload") or {}).get("owner_ref")
                != candidate.get("owner_ref")):
            raise ValueError("repair record must bind the candidate owner and change")
    allowed_fields = set(required) | {
        "kind", "convergence_owner_ref", "repair_input", "convergence_input",
        "forward_recovery_ref", "hostile_proof", "deepest_owner_proof",
        "caller_sibling_sweep", "review", "transfer_payload", "correlation_refs",
        "real_outcome_proof", "compatibility", "expected_outcome",
        "supersedes_candidate_revision_ref",
    }
    unknown = sorted(set(candidate) - allowed_fields)
    if unknown:
        raise ValueError("candidate contains undeclared fields: %s" % ", ".join(unknown))
    review = candidate.get("review") or {}
    if (review.get("state") != "approved" or not review.get("reviewer_ref")
            or not review.get("evidence_refs")
            or set(review) - {"state", "reviewer_ref", "evidence_refs", "reviewed_at"}):
        raise ValueError("candidate requires an approved evidence-backed review")
    if (not all(privacy_safe_ref(candidate.get(name)) for name in required)
            or not all(privacy_safe_ref(ref) for ref in review.get("evidence_refs", []))
            or not privacy_safe_ref(review.get("reviewer_ref"))
            or (candidate.get("supersedes_candidate_revision_ref") is not None
                and not privacy_safe_ref(candidate.get("supersedes_candidate_revision_ref")))):
        raise ValueError("candidate refs must be bounded opaque identities")
    for proof_name in ("deepest_owner_proof", "caller_sibling_sweep", "hostile_proof"):
        proof = candidate.get(proof_name) or {}
        if (proof.get("state") != "passed" or not proof.get("evidence_refs")
                or set(proof) - {"state", "evidence_refs"}):
            raise ValueError("candidate requires passed %s" % proof_name)
        if not all(privacy_safe_ref(ref) for ref in proof["evidence_refs"]):
            raise ValueError("candidate proof refs must be bounded opaque identities")
    if contains_private_material({
            "transfer_payload": candidate.get("transfer_payload") or {},
            "repair_input": candidate.get("repair_input") or {},
            "convergence_input": candidate.get("convergence_input") or {},
            "review": review,
            "deepest_owner_proof": candidate.get("deepest_owner_proof"),
            "caller_sibling_sweep": candidate.get("caller_sibling_sweep"),
            "hostile_proof": candidate.get("hostile_proof"),
    }):
        raise ValueError("candidate contains private material")
    if not privacy_safe_transfer_payload(candidate.get("transfer_payload") or {}):
        raise ValueError("candidate transfer payload must contain only opaque refs")
    expectation = candidate.get("expected_outcome") or {}
    if (not isinstance(expectation.get("path"), list)
            or expectation.get("direction") not in {"increase", "decrease", "change-to"}
            or ("value" in expectation
                and not privacy_safe_outcome_value(expectation.get("value")))):
        raise ValueError("candidate expected_outcome is not privacy-safe")
    materialized_candidate = {"kind": "fleet-learning-repair-candidate", **candidate}
    candidate_revision_ref = stable_ref(
        "fleet-learning-repair-candidate-revision", materialized_candidate)
    return {
        "record": {
            "address_label": "package::ai-execution-history::fleet-repair-candidate::%s::%s"
                             % (token(candidate["candidate_ref"]),
                                token(candidate_revision_ref)),
            "payload": {**materialized_candidate,
                        "candidate_revision_ref": candidate_revision_ref},
        }
    }


def current_repair_candidates(request):
    """Resolve one immutable linear candidate revision chain per identity."""
    grouped = {}
    for candidate in request.get("repair_candidates", []):
        candidate_ref = candidate.get("candidate_ref")
        value = dict(candidate)
        claimed_revision_ref = value.pop("candidate_revision_ref", None)
        computed_revision_ref = stable_ref("fleet-learning-repair-candidate-revision", value)
        revision_ref = claimed_revision_ref or computed_revision_ref
        if claimed_revision_ref and claimed_revision_ref != computed_revision_ref:
            revision_ref = "invalid:%s" % claimed_revision_ref
        fingerprints = grouped.setdefault(candidate_ref, {}).setdefault(revision_ref, set())
        fingerprints.add(json.dumps(candidate, sort_keys=True, separators=(",", ":")))
    admitted, rejected = [], []
    for candidate_ref, revision_variants in grouped.items():
        revisions = {ref: json.loads(next(iter(variants)))
                     for ref, variants in revision_variants.items() if len(variants) == 1}
        if not candidate_ref:
            rejected.append({"candidate_ref": candidate_ref, "state": "rejected",
                             "reason": "candidate-ref-absent"})
            continue
        if (len(revisions) != len(revision_variants)
                or any(ref.startswith("invalid:") for ref in revisions)):
            rejected.append({"candidate_ref": candidate_ref, "state": "rejected",
                             "reason": "candidate-revision-integrity-mismatch"})
            continue
        superseded, valid = {}, True
        for revision_ref, candidate in revisions.items():
            previous = candidate.get("supersedes_candidate_revision_ref")
            if previous is not None and previous not in revisions:
                valid = False
                break
            if previous in superseded:
                valid = False
                break
            if previous is not None:
                superseded[previous] = revision_ref
        heads = set(revisions) - set(superseded)
        if not valid or len(heads) != 1:
            rejected.append({"candidate_ref": candidate_ref, "state": "rejected",
                             "reason": "ambiguous-candidate-revisions"})
            continue
        head = next(iter(heads))
        visited, cursor = set(), head
        while cursor is not None and cursor not in visited:
            visited.add(cursor)
            cursor = revisions[cursor].get("supersedes_candidate_revision_ref")
        if cursor is not None or len(visited) != len(revisions):
            rejected.append({"candidate_ref": candidate_ref, "state": "rejected",
                             "reason": "ambiguous-candidate-revisions"})
            continue
        current = revisions[head]
        if not current.get("candidate_revision_ref"):
            current = {**current, "candidate_revision_ref": head}
        admitted.append(current)
    admitted.sort(key=lambda item: item["candidate_ref"])
    rejected.sort(key=lambda item: str(item.get("candidate_ref")))
    return admitted, rejected


def resolve_application_observation(request, application_id, installation_ref, min_trust_score):
    rows = [row for row in request.get("application_observations", [])
            if row.get("application_id") == application_id]
    if not rows:
        return None, None
    by_ref = {}
    for row in rows:
        ref = row.get("observation_ref")
        if not isinstance(ref, str) or not ref.strip() or ref != ref.strip() \
                or parse_observed_at(row.get("observed_at")) is None \
                or not trusted_observation(row, installation_ref, min_trust_score, request):
            return "rejected", "application-observation-invalid"
        fingerprints = by_ref.setdefault(ref, set())
        fingerprints.add(json.dumps(row, sort_keys=True, separators=(",", ":")))
    if any(len(fingerprints) > 1 for fingerprints in by_ref.values()):
        return "rejected", "application-observation-ambiguous"
    ordered = sorted(rows, key=lambda row: parse_observed_at(row["observed_at"]))
    for previous, current in zip(ordered, ordered[1:]):
        if (parse_observed_at(previous["observed_at"]) == parse_observed_at(current["observed_at"])
                and previous != current):
            return "rejected", "application-observation-ambiguous"
    latest = ordered[-1]
    latest_state = latest.get("state")
    if latest_state not in {"received", "current", "used", "failed"}:
        return "rejected", "application-observation-invalid"
    failures = [row for row in ordered if row.get("state") == "failed"]
    if latest_state == "failed":
        return "forward-recovery-required", "application-failed"
    if failures and latest.get("recovers_observation_ref") != failures[-1].get("observation_ref"):
        return "forward-recovery-required", "application-recovery-not-proven"
    return latest_state, None


def improvement_observation(request, candidate, installation_ref, application_id,
                            min_trust_score, contract):
    candidate_ref = candidate.get("candidate_ref")
    rows = [row for row in request.get("outcome_observations", [])
            if row.get("candidate_ref") == candidate_ref
            and row.get("installation_ref") == installation_ref]
    by_attempt = {}
    for row in rows:
        identity = (row.get("phase"), row.get("attempt_ref"))
        fingerprints = by_attempt.setdefault(identity, {})
        fingerprints[json.dumps(row, sort_keys=True, separators=(",", ":"))] = row
    if any(len(fingerprints) > 1 for fingerprints in by_attempt.values()):
        return {"improved": False, "reason": "ambiguous-attempt-observation"}
    unique_rows = [next(iter(fingerprints.values())) for fingerprints in by_attempt.values()]
    before_by_attempt = {row.get("attempt_ref"): row for row in unique_rows
                         if row.get("phase") == "before"}
    linked_pairs = [(before_by_attempt.get(row.get("prior_attempt_ref")), row)
                    for row in unique_rows if row.get("phase") == "after"
                    and before_by_attempt.get(row.get("prior_attempt_ref"))]
    if not linked_pairs:
        return {"improved": False, "reason": "comparable-later-outcome-absent"}
    instants = [parse_observed_at(pair[1].get("observed_at")) for pair in linked_pairs]
    if any(instant is None for instant in instants):
        return {"improved": False, "reason": "distinct-later-attempt-not-proven"}
    if len(set(instants)) != len(instants):
        return {"improved": False, "reason": "ambiguous-attempt-observation"}
    before, after = max(zip(instants, linked_pairs), key=lambda pair: pair[0])[1]
    if not trusted_observation(before, installation_ref, min_trust_score, request) \
            or not trusted_observation(after, installation_ref, min_trust_score, request):
        return {"improved": False, "reason": "poisoned-or-untrusted-outcome-observation"}
    if before.get("evidence_class") != "observed-real" or after.get("evidence_class") != "observed-real":
        return {"improved": False, "reason": "real-outcome-evidence-absent"}
    expected_correlation = complete_outcome_correlation(candidate, contract)
    before_correlation = complete_outcome_correlation(before, contract)
    after_correlation = complete_outcome_correlation(after, contract)
    if before_correlation != expected_correlation:
        return {"improved": False, "reason": "source-result-job-outcome-correlation-mismatch"}
    if after_correlation is None:
        return {"improved": False, "reason": "source-result-job-outcome-correlation-absent"}
    expected_real_outcome = complete_real_outcome_proof(candidate, contract)
    before_real_outcome = complete_real_outcome_proof(before, contract)
    after_real_outcome = complete_real_outcome_proof(after, contract)
    if before_real_outcome is None or after_real_outcome is None:
        return {"improved": False, "reason": contract["failure_reasons"]["absent"]}
    if before_real_outcome != expected_real_outcome:
        return {"improved": False, "reason": contract["failure_reasons"]["mismatch"]}
    if (not proof_matches_correlation(before_real_outcome, before_correlation, contract)
            or not proof_matches_correlation(after_real_outcome, after_correlation, contract)):
        return {"improved": False, "reason": contract["failure_reasons"]["correlation_mismatch"]}
    before_attempt = before.get("attempt_ref")
    after_attempt = after.get("attempt_ref")
    before_time = parse_observed_at(before.get("observed_at"))
    after_time = parse_observed_at(after.get("observed_at"))
    if (not isinstance(before_attempt, str) or not before_attempt.strip()
            or not isinstance(after_attempt, str) or not after_attempt.strip()
            or before_attempt == after_attempt
            or after.get("prior_attempt_ref") != before_attempt
            or before_time is None or after_time is None or after_time <= before_time):
        return {"improved": False, "reason": "distinct-later-attempt-not-proven"}
    if (after_correlation == before_correlation
            or any(get_path(after_real_outcome, path) == get_path(before_real_outcome, path)
                   for path in contract["distinct_proof_paths"])):
        return {"improved": False, "reason": "distinct-later-attempt-not-proven"}
    applicability_ref = candidate.get("applicability_ref")
    if (not isinstance(applicability_ref, str) or not applicability_ref.strip()
            or before.get("applicability_ref") != applicability_ref
            or after.get("applicability_ref") != applicability_ref):
        return {"improved": False, "reason": "later-attempt-applicability-mismatch"}
    if (after.get("application_id") != application_id
            or after.get("applied_candidate_ref") != candidate_ref
            or after.get("change_ref") != candidate.get("change_ref")
            or after.get("selection_or_execution_changed") is not True
            or not isinstance(after.get("change_evidence_ref"), str)
            or not after.get("change_evidence_ref").strip()
            or after.get("change_evidence_ref") != after.get("change_evidence_ref").strip()):
        return {"improved": False, "reason": "learning-caused-later-change-not-proven"}
    expectation = candidate.get("expected_outcome") or {}
    before_value = get_path(before, expectation.get("path"))
    after_value = get_path(after, expectation.get("path"))
    if not privacy_safe_outcome_value(before_value) or not privacy_safe_outcome_value(after_value):
        return {"improved": False, "reason": "privacy-safe-outcome-measure-absent"}
    direction = expectation.get("direction")
    improved = ((direction == "increase" and isinstance(before_value, (int, float))
                 and isinstance(after_value, (int, float)) and after_value > before_value)
                or (direction == "decrease" and isinstance(before_value, (int, float))
                    and isinstance(after_value, (int, float)) and after_value < before_value)
                or (direction == "change-to" and after_value == expectation.get("value")
                    and before_value != after_value))
    return {"improved": bool(improved), "before": before_value, "after": after_value,
            **({} if improved else {"reason": "later-outcome-did-not-improve"})}


def evaluate(request):
    request = expand_record_feed(request)
    learning_bindings, learning_conflicts = unambiguous_records(
        request.get("saved_result_learning_bindings", []), ("binding_ref",))
    # The existing selector rereads binding, permission and exact saved owners.
    # Only opaque binding refs leave this planner; never fetch result prose here.
    eligible_bindings = [(identity, binding) for identity, binding in sorted(learning_bindings.items())
                         if binding.get("state") == "active" and privacy_safe_ref(identity[0])]
    learning_leases, lease_conflicts = unambiguous_records(request.get("permission_leases", []), ("lease_ref",))
    authorized_learning_leases = []
    for identity, lease in sorted(learning_leases.items()):
        context = active_permission_context(
            lease, ("learn-local-saved-result", "learn-local-useful-impact"),
            authorization_time_ms(request))
        allowed_context_fields = {"work_ref", "observer_id", "candidate_id", "candidate_material_ref",
                                  "installation_ref", "user_ref", "selection_surface_ref",
                                  "applicability_ref", "useful_impact"}
        if (context is not None and privacy_safe_ref(identity[0])
                and set(context).issubset(allowed_context_fields)
                and lease.get("subject_ref") == context.get("user_ref")
                and all(privacy_safe_ref(context.get(field)) for field in (
                    "work_ref", "observer_id", "candidate_id", "candidate_material_ref",
                    "installation_ref", "user_ref", "selection_surface_ref", "applicability_ref"))
                and isinstance(context.get("useful_impact"), dict)
                and not contains_private_material(context["useful_impact"])):
            authorized_learning_leases.append((identity, lease))
    deriving_refs = {identity[0] for identity, _ in authorized_learning_leases}
    eligible_bindings = [(identity, binding) for identity, binding in eligible_bindings
                         if binding.get("permission_lease_ref") not in deriving_refs]
    eligible_bindings += [(identity, {"_permission_lease": True}) for identity, _ in authorized_learning_leases]
    eligible_bindings.sort(key=lambda item: item[0])
    prior_summaries, _ = unambiguous_records(request.get("learning_summaries", []), ("id",))
    cursor = prior_summaries.get(("fleet-learning-summary:current",), {}).get("saved_result_cursor", "")
    if not isinstance(cursor, str) or (cursor and not privacy_safe_ref(cursor)):
        cursor = ""
    eligible_bindings = ([item for item in eligible_bindings if item[0][0] > cursor]
                         + [item for item in eligible_bindings if item[0][0] <= cursor])
    learning_requests = [{"definition_id": "action:choose-per-observer:observe-saved-work-result",
                          "input": {"permission_lease_ref" if binding.get("_permission_lease") else "binding_ref": identity[0]}}
                         for identity, binding in eligible_bindings[:64]]
    learning_rejections = [{"binding_ref": identity[0], "state": "rejected",
                            "reason": "saved-result-binding-ambiguous"}
                           for identity in sorted(learning_conflicts) if privacy_safe_ref(identity[0])]
    learning_rejections += [{"permission_lease_ref": identity[0], "state": "rejected",
                             "reason": "saved-result-permission-ambiguous"}
                            for identity in sorted(lease_conflicts) if privacy_safe_ref(identity[0])]
    learning_rejections += [{"permission_lease_ref": identity[0], "state": "rejected",
                             "reason": "saved-result-permission-expired-or-invalid"}
                            for identity, lease in sorted(learning_leases.items())
                            if privacy_safe_ref(identity[0])
                            and isinstance(lease.get("allowed_operation_refs"), list)
                            and any(operation in lease["allowed_operation_refs"] for operation in (
                                "learn-local-saved-result", "learn-local-useful-impact"))
                            and identity not in lease_conflicts
                            and active_permission_context(
                                lease, ("learn-local-saved-result", "learn-local-useful-impact"),
                                authorization_time_ms(request)) is None]
    runs, rejections = trusted_runs(request)
    candidates, applications, repair_requests, convergence_requests = [], [], [], []
    installation_rows, installation_conflicts = unambiguous_records(
        request.get("installations", []), ("installation_ref",))
    installations = {key[0]: row for key, row in installation_rows.items()}
    installations.update({key[0]: {"installation_ref": key[0]}
                          for key in installation_conflicts})
    rule_rows, rule_conflicts = unambiguous_records(
        request.get("failure_signal_rules", []), ("rule_ref",))
    rules = {key[0]: row for key, row in rule_rows.items()}
    repair_candidates, candidate_identity_rejections = current_repair_candidates(request)
    analysis_request = {**request, "repair_candidates": repair_candidates}
    analysis_requests, analysis_clusters, analysis_rejections = plan_failure_analysis(
        analysis_request, runs, rules)
    analysis_requests, worker_requests = plan_authorized_analysis_dispatch(
        request, analysis_requests, analysis_clusters)
    candidates.extend(candidate_identity_rejections)
    for candidate in repair_candidates:
        candidate_ref = candidate.get("candidate_ref")
        rule = rules.get(candidate.get("rule_ref"))
        state, reason = "actionable", None
        matched = [run for run in runs if rule and matches(run, rule.get("predicates"))]
        contract = outcome_contract(rule, candidate)
        expected_correlation = complete_outcome_correlation(candidate, contract) if contract else None
        expected_real_outcome = complete_real_outcome_proof(candidate, contract) if contract else None
        distinct_sessions = {run.get("id") for run in matched}
        distinct_installations = {(run.get("provenance") or {}).get("installation_ref") for run in matched}
        distinct_installations.discard(None)
        if (candidate.get("rule_ref"),) in rule_conflicts:
            state, reason = "rejected", "signal-rule-ambiguous"
        elif not rule:
            state, reason = "rejected", "signal-rule-absent"
        elif contract is None:
            state, reason = "rejected", "outcome-contract-absent-invalid-or-changed"
        elif len(distinct_sessions) < rule.get("min_distinct_sessions", 1):
            state, reason = "rejected", "insufficient-distinct-sessions"
        elif len(distinct_installations) < rule.get("min_distinct_installations", 1):
            state, reason = "rejected", "negative-transfer-risk"
        elif any((run.get("trust") or {}).get("score", 0) < rule.get("min_trust_score", 0)
                 for run in matched):
            state, reason = "rejected", "trust-threshold-not-met"
        elif (candidate.get("hostile_proof") or {}).get("state") != "passed":
            state, reason = "rejected", "hostile-proof-not-passed"
        elif (contains_private_material({
                "transfer_payload": candidate.get("transfer_payload") or {},
                "repair_input": candidate.get("repair_input") or {},
                "convergence_input": candidate.get("convergence_input") or {},
        }) or not privacy_safe_transfer_payload(candidate.get("transfer_payload") or {})):
            state, reason = "rejected", "private-material-in-outbound-payload"
        elif expected_real_outcome is None:
            state, reason = "rejected", contract["failure_reasons"]["absent"]
        elif any(complete_real_outcome_proof(run, contract) is None for run in matched):
            state, reason = "rejected", contract["failure_reasons"]["absent"]
        elif any(complete_real_outcome_proof(run, contract) != expected_real_outcome for run in matched):
            state, reason = "rejected", contract["failure_reasons"]["mismatch"]
        elif expected_correlation is None:
            state, reason = "rejected", "source-result-job-outcome-correlation-absent"
        elif any(complete_outcome_correlation(run, contract) != expected_correlation for run in matched):
            state, reason = "rejected", "source-result-job-outcome-correlation-mismatch"
        elif not proof_matches_correlation(expected_real_outcome, expected_correlation, contract):
            state, reason = "rejected", contract["failure_reasons"]["correlation_mismatch"]
        elif not candidate.get("owner_ref") or not candidate.get("change_ref"):
            state, reason = "rejected", "canonical-owner-or-change-absent"
        elif not candidate.get("repair_action_ref") or not candidate.get("convergence_action_ref"):
            state, reason = "rejected", "repair-or-convergence-action-absent"
        candidate_result = {
            "candidate_ref": candidate_ref, "state": state,
            "candidate_revision_ref": candidate.get("candidate_revision_ref"),
            "matched_session_count": len(distinct_sessions),
            "matched_installation_count": len(distinct_installations),
            "owner_ref": candidate.get("owner_ref"), "change_ref": candidate.get("change_ref"),
            **({"reason": reason} if reason else {}),
        }
        candidates.append(candidate_result)
        if state != "actionable":
            continue
        repair_requests.append({
            "candidate_ref": candidate_ref,
            "definition_id": candidate.get("repair_action_ref"),
            "input": candidate.get("repair_input") or {
                "candidate_ref": candidate_ref,
                "owner_ref": candidate.get("owner_ref"),
                "change_ref": candidate.get("change_ref"),
            },
        })
        compatibility = candidate.get("compatibility") or {}
        candidate_applications = []
        for installation_ref, installation in installations.items():
            app_state, app_reason = "eligible", None
            capability_rows = installation.get("capabilities", [])
            tag_rows = installation.get("tags", [])
            compatibility_valid = isinstance(compatibility, dict) and all(
                isinstance(values, list) and all(isinstance(item, str) and item for item in values)
                for values in [capability_rows, tag_rows,
                               compatibility.get("requires_all", []) if isinstance(compatibility, dict) else None,
                               compatibility.get("rejects_any", []) if isinstance(compatibility, dict) else None])
            capabilities = set(capability_rows) if compatibility_valid else set()
            tags = set(tag_rows) if compatibility_valid else set()
            if (installation_ref,) in installation_conflicts:
                app_state, app_reason = "rejected", "installation-permission-or-capability-ambiguous"
            elif not compatibility_valid:
                app_state, app_reason = "incompatible", "compatibility-contract-invalid"
            elif installation.get("receiver_state") != "available":
                app_state, app_reason = "absent", "receiver-absent"
            elif installation.get("consent_state") != "active":
                app_state, app_reason = "rejected", "receiver-consent-absent-or-revoked"
            elif not set(compatibility.get("requires_all") or []).issubset(capabilities):
                app_state, app_reason = "incompatible", "required-capability-absent"
            elif set(compatibility.get("rejects_any") or []).intersection(tags):
                app_state, app_reason = "incompatible", "incompatible-installation-tag"
            application_id = "fleet-improvement-application:%s:%s:%s" % (
                token(candidate_ref), token(installation_ref), token(candidate.get("change_ref")))
            observed_state, observed_reason = resolve_application_observation(
                request, application_id, installation_ref,
                rule.get("min_trust_score", 0))
            if app_state == "eligible" and observed_state:
                app_state, app_reason = observed_state, observed_reason
            improvement = improvement_observation(
                request, candidate, installation_ref, application_id,
                rule.get("min_trust_score", 0), contract)
            if app_state == "used" and improvement["improved"]:
                app_state = "improved"
            candidate_applications.append({
                "application_id": application_id,
                "candidate_ref": candidate_ref,
                "installation_ref": installation_ref,
                "state": app_state,
                "change_ref": candidate.get("change_ref"),
                "convergence_owner_ref": candidate.get("convergence_owner_ref"),
                "forward_recovery_ref": candidate.get("forward_recovery_ref"),
                "outcome": improvement,
                **({"reason": app_reason} if app_reason else {}),
            })
        # A repair request is not an applied repair. Transfer only after the
        # existing observation owner proves a causal later improvement at a
        # currently consenting, compatible installation in the evidence cohort.
        # Resolve the whole cohort first so receiver order cannot grant transfer.
        proven_origin = any(
            item["state"] == "improved"
            and item["installation_ref"] in distinct_installations
            for item in candidate_applications)
        for application in candidate_applications:
            if application["state"] == "eligible" and not proven_origin:
                application["state"] = "awaiting-repair-verification"
                application["reason"] = "originating-later-improvement-unverified"
            applications.append(application)
            if application["state"] == "eligible":
                convergence_requests.append({
                    "application_id": application["application_id"],
                    "installation_ref": application["installation_ref"],
                    "definition_id": candidate.get("convergence_action_ref"),
                    "input": {
                        **(candidate.get("convergence_input") or {}),
                        "installation_ref": application["installation_ref"],
                        "change_ref": candidate.get("change_ref"),
                        "application_id": application["application_id"],
                    },
                })
    summary = {
        "saved_result_cursor": next(iter(learning_requests[-1]["input"].values())) if learning_requests else cursor,
        "saved_result_deferred_count": max(0, len(eligible_bindings) - len(learning_requests)),
        "saved_result_rejection_count": len(learning_rejections),
        "trusted_run_count": len(runs),
        "analysis_requested_count": len(analysis_requests),
        "actionable_candidate_count": sum(x["state"] == "actionable" for x in candidates),
        "improved_installation_count": sum(x["state"] == "improved" for x in applications),
    }
    records = [{
        "address_label": "package::ai-execution-history::fleet-learning-summary::current",
        "payload": {"kind": "fleet-learning-summary", "id": "fleet-learning-summary:current", **summary},
    }]
    records.extend({
        "address_label": "package::ai-execution-history::fleet-candidate::%s" % token(item["candidate_ref"]),
        "payload": {"kind": "fleet-learning-candidate-evaluation", **item},
    } for item in candidates)
    records.extend({"address_label": "package::ai-execution-history::saved-result-rejection::%s" % token(item.get("binding_ref", item.get("permission_lease_ref"))),
                    "payload": {"kind": "fleet-learning-evidence-rejection", **item}}
                   for item in learning_rejections)
    records.extend({
        "address_label": "package::ai-execution-history::fleet-application::%s" % token(item["application_id"]),
        "payload": {"kind": "fleet-learning-application", **item},
    } for item in applications)
    records.extend({
        "address_label": "package::ai-execution-history::fleet-evidence-rejection::%s" % token(item.get("run_ref")),
        "payload": {"kind": "fleet-learning-evidence-rejection", **item},
    } for item in rejections)
    records.extend({
        "address_label": "package::ai-execution-history::fleet-analysis::%s"
                         % token(item["analysis_ref"]),
        "payload": {"kind": "fleet-learning-analysis-state", **item},
    } for item in analysis_clusters)
    records.extend({
        "address_label": "package::ai-execution-history::fleet-analysis-rejection::%s::%s"
                         % (token(item.get("policy_ref")), token(item.get("run_ref"))),
        "payload": {"kind": "fleet-learning-analysis-rejection", **item},
    } for item in analysis_rejections)
    return {"candidates": candidates, "applications": applications,
            "analysis_requests": analysis_requests, "analysis_clusters": analysis_clusters,
            "worker_requests": worker_requests,
            "learning_requests": learning_requests,
            "learning_rejections": learning_rejections,
            "analysis_rejections": analysis_rejections,
            "repair_requests": repair_requests, "convergence_requests": convergence_requests,
            "evidence_rejections": rejections, "summary": summary, "records": records}


def finalize_dispatches(request):
    """Keep dispatch failure visible without exporting error text or claiming effects.

    Workflow supplies ordered loop results, including its tolerated_error values.
    A returned call is not proof of execution, repair, adoption, or improvement.
    """
    evaluation = request["evaluation"]
    reports = []
    for group in request["dispatch_groups"]:
        requests = group["requests"]
        results = group.get("results")
        if not isinstance(requests, list):
            raise ValueError("dispatch requests must be an array")
        aligned = isinstance(results, list) and len(results) == len(requests)
        for index, planned in enumerate(requests):
            result = results[index] if aligned else None
            state, reason = "unverified", "dispatch-result-absent-or-misaligned"
            started = {}
            if isinstance(result, dict):
                if ("tolerated_error" in result or result.get("error")
                        or result.get("success") is False
                        or result.get("status") in ("failed", "rejected", "cancelled")
                        or result.get("state") in ("failed", "rejected", "cancelled")):
                    state, reason = "failed", "dispatch-failed"
                else:
                    reason = "dispatch-returned-effect-not-verified"
                    output = result.get("output", result)
                    if (group.get("kind") == "authorized-worker"
                            and planned.get("definition_id") == "action:process-session:start-authorized-assigned-work-session"
                            and isinstance(output, dict)
                            and output.get("sourceRef") == planned.get("input", {}).get("sourceRecordRef")
                            and privacy_safe_ref(output.get("sessionId"))
                            and privacy_safe_ref(output.get("workerRef"))):
                        state, reason = "started", "authorized-worker-started-result-not-yet-verified"
                        started = {"session_ref": output["sessionId"]}
            reports.append({
                "request_ref": stable_ref("fleet-dispatch-request", planned),
                "state": state,
                "reason": reason,
                **started,
            })
        if not aligned and not requests:
            reports.append({"request_ref": stable_ref("fleet-dispatch-request", requests),
                            "state": "unverified", "reason": "unexpected-dispatch-results"})
    summary = {"kind": "fleet-learning-dispatch-summary",
               "id": "fleet-learning-dispatch-summary:current",
               "failed_count": sum(row["state"] == "failed" for row in reports),
               "unverified_count": sum(row["state"] == "unverified" for row in reports),
               "requests": reports}
    return {**evaluation, "dispatch": summary,
            "records": [*evaluation["records"], {
                "address_label": "package::ai-execution-history::fleet-dispatch-summary::current",
                "payload": summary,
            }]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("plan-discovery", "evaluate", "validate-candidate", "finalize-dispatches"))
    parser.add_argument("request")
    parser.add_argument("result")
    parser.add_argument("--authorization-time")
    args = parser.parse_args()
    with open(args.request, encoding="utf-8") as handle:
        request = json.load(handle)
    if args.authorization_time:
        with open(args.authorization_time, encoding="utf-8") as handle:
            time_observation = json.load(handle)
        now_ms = time_observation.get("now_ms") if isinstance(time_observation, dict) else None
        if not isinstance(now_ms, int) or isinstance(now_ms, bool) or not 0 <= now_ms <= 9007199254740991:
            raise ValueError("Authorization time is invalid.")
        request = {"records": request} if isinstance(request, list) else dict(request)
        request["authorization_time_ms"] = now_ms
    if args.mode == "plan-discovery":
        result = plan_discovery(request)
    elif args.mode == "validate-candidate":
        result = validate_repair_candidate(request)
    elif args.mode == "finalize-dispatches":
        result = finalize_dispatches(request)
    else:
        result = evaluate(request)
    with open(args.result, "w", encoding="utf-8") as handle:
        json.dump(result, handle, sort_keys=True)


if __name__ == "__main__":
    sys.exit(main())
