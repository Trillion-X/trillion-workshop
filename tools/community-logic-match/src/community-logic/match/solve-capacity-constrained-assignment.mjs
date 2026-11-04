// Vendored unchanged except for import paths from bitfield-packages/packages/interaction-program/do-work/solve-capacity-constrained-assignment.mjs.
import {
  expectedValueAdmission,
  needleMoverScopeKey,
  selectionBoundary,
} from "../../../../match-community-members/src/community-logic/match/bounded-candidates.mjs";

const OWNER_REUSE_REFS = Object.freeze([
  "group",
  "coordination-session",
  "progression-evaluator",
  "suggested-match",
  "interaction-program/read-data/select-pairs.mjs#selectPairs",
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function stableString(value) {
  return typeof value === "string" ? value : JSON.stringify(canonicalize(value));
}

function identityOf(value, fields) {
  if (value == null) return null;
  if (typeof value !== "object") return String(value);
  for (const field of fields) {
    if (value[field] != null) return stableString(value[field]);
  }
  return stableString(value);
}

function seekerRef(seeker) {
  return identityOf(seeker, ["help_seeker_ref", "seeker_ref", "participant_ref", "id", "ref"]);
}

function helperRef(helper) {
  return identityOf(helper, ["helper_candidate_ref", "helper_ref", "target_ref", "participant_ref", "id", "ref"]);
}

function matchCaseId(seeker) {
  return seeker && typeof seeker === "object" && seeker.match_case_id != null
    ? stableString(seeker.match_case_id)
    : `match-case:${seekerRef(seeker)}`;
}

function pairKey(helpSeekerRef, helperCandidateRef) {
  return `${stableString(helpSeekerRef)}|${stableString(helperCandidateRef)}`;
}

function demandOf(seeker, request) {
  const value = seeker?.demand ?? seeker?.required_assignment_count ?? request.default_demand;
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function capacityInputValue(input, ref) {
  if (Array.isArray(input)) return undefined;
  const entry = input?.[ref];
  const value = typeof entry === "object" && entry !== null
    ? entry.capacity ?? entry.limit
    : entry;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function capacityRequestFromExpectedValueCandidates(inputCandidates, request = {}) {
  const candidates = Array.isArray(inputCandidates) ? inputCandidates : [];
  const admitted = [];
  const rejected = [];
  const cases = new Map();
  const helpers = new Map();
  const helperEdgeCounts = new Map();
  const requiredAssignments = Number.isInteger(request.group_size) && request.group_size >= 2
    ? request.group_size - 1
    : 1;

  for (const candidate of candidates) {
    const helpSeekerRef = typeof candidate?.subject === "string" && candidate.subject.length > 0
      ? candidate.subject
      : null;
    const helperValue = candidate?.resource_ref ?? candidate?.participant;
    const helperCandidateRef = typeof helperValue === "string" && helperValue.length > 0
      ? helperValue
      : null;
    const scopeKey = candidate?.scope_key ?? needleMoverScopeKey(candidate);
    const caseId = helpSeekerRef && scopeKey ? `match-case:${scopeKey}:${helpSeekerRef}` : null;
    if (caseId && !cases.has(caseId)) {
      cases.set(caseId, {
        match_case_id: caseId,
        help_seeker_ref: helpSeekerRef,
        scope: candidate.scope,
        demand: requiredAssignments,
      });
    }
    const admission = expectedValueAdmission(candidate, request.expected_value);
    if (!admission.admitted || !caseId || !helperCandidateRef) {
      rejected.push({
        help_seeker_ref: helpSeekerRef,
        helper_candidate_ref: helperCandidateRef,
        reason: admission.reason ?? "candidate_identity_missing",
      });
      continue;
    }
    if (!helpers.has(helperCandidateRef)) {
      helpers.set(helperCandidateRef, {
        helper_candidate_ref: helperCandidateRef,
        capacity_ref: candidate.capacity_ref ?? helperCandidateRef,
      });
    }
    helperEdgeCounts.set(helperCandidateRef, (helperEdgeCounts.get(helperCandidateRef) ?? 0) + 1);
    admitted.push({
      match_case_id: caseId,
      help_seeker_ref: helpSeekerRef,
      helper_candidate_ref: helperCandidateRef,
      expected_value: candidate.expected_value,
      factors: candidate.factors,
      factor_evidence: candidate.factor_evidence,
      evidence_refs: candidate.evidence_refs ?? [],
      justification_status: candidate.justification_status ?? null,
      scope: candidate.scope,
      scope_key: scopeKey,
      eligible: true,
      eligibility_predicate_refs: candidate.eligibility_predicate_refs ?? [],
      ranking_policy_ref: "expected-value-product",
      explanation: candidate.why ?? null,
      session_ref: candidate.session_ref ?? null,
      mode: candidate.mode ?? null,
    });
  }

  const sourceCapacities = request.capacities ?? request.per_target_capacities ?? {};
  const capacities = Object.fromEntries([...helpers.keys()].map((ref) => {
    const explicit = capacityInputValue(sourceCapacities, ref);
    const capacity = explicit ?? (request.exclusive_participation === true
      ? 1
      : helperEdgeCounts.get(ref));
    return [ref, { capacity, capacity_ref: helpers.get(ref).capacity_ref }];
  }));

  return {
    operation: "solve_capacity_constraints",
    help_seekers: [...cases.values()],
    helper_candidates: [...helpers.values()],
    capacities,
    candidate_edges: admitted,
    expected_value: request.expected_value ?? {},
    rejected_candidates: rejected,
  };
}

function normalizePredicateRefs(request, seeker, helper) {
  const refs = [
    ...(Array.isArray(request.eligibility_predicate_refs) ? request.eligibility_predicate_refs : []),
    request.eligibility_predicate_ref,
    request.eligibility_predicate,
    seeker?.eligibility_predicate_ref,
    seeker?.eligibility_predicate,
    helper?.eligibility_predicate_ref,
    helper?.eligibility_predicate,
  ].filter((value) => value != null);
  return [...new Set(refs.map(stableString))].sort();
}

function predicateResolver(request, predicateRef) {
  if (typeof request.resolve_eligibility_predicate === "function") {
    return (context) => request.resolve_eligibility_predicate(predicateRef, context);
  }
  const predicate = request.eligibility_predicates?.[predicateRef];
  return typeof predicate === "function" ? predicate : null;
}

function evaluateEligibility(request, seeker, helper) {
  const predicateRefs = normalizePredicateRefs(request, seeker, helper);
  const evidence = request.eligibility_evidence?.[pairKey(seekerRef(seeker), helperRef(helper))];
  if (evidence != null) {
    const eligible = typeof evidence === "boolean" ? evidence : evidence.eligible === true;
    return {
      eligible,
      predicate_refs: predicateRefs,
      reason: eligible ? null : evidence.reason ?? "eligibility_evidence_rejected",
    };
  }
  if (predicateRefs.length === 0) {
    return { eligible: false, predicate_refs: [], reason: "eligibility_predicate_missing" };
  }
  for (const predicateRef of predicateRefs) {
    const predicate = predicateResolver(request, predicateRef);
    if (!predicate) {
      return { eligible: false, predicate_refs: predicateRefs, reason: "eligibility_predicate_unresolved" };
    }
    const result = predicate({ request, seeker, helper, predicate_ref: predicateRef });
    const eligible = typeof result === "boolean" ? result : result?.eligible === true;
    if (!eligible) {
      return {
        eligible: false,
        predicate_refs: predicateRefs,
        reason: result?.reason ?? "eligibility_predicate_rejected",
      };
    }
  }
  return { eligible: true, predicate_refs: predicateRefs, reason: null };
}

function rankingResolver(request, rankingPolicyRef) {
  if (typeof request.resolve_ranking_policy === "function") {
    return (context) => request.resolve_ranking_policy(rankingPolicyRef, context);
  }
  const policy = request.ranking_policies?.[rankingPolicyRef];
  return typeof policy === "function" ? policy : null;
}

function evaluateRanking(request, seeker, helper) {
  const rankingPolicyRef = stableString(
    seeker?.ranking_policy_ref ?? helper?.ranking_policy_ref ?? request.ranking_policy_ref ?? "",
  );
  const explicitScore = request.ranking_scores?.[pairKey(seekerRef(seeker), helperRef(helper))];
  if (typeof explicitScore === "number" && Number.isFinite(explicitScore)) {
    return { resolved: true, score: explicitScore, explanation: null, ranking_policy_ref: rankingPolicyRef || null };
  }
  if (!rankingPolicyRef) {
    return { resolved: false, score: null, explanation: null, ranking_policy_ref: null };
  }
  const policy = rankingResolver(request, rankingPolicyRef);
  if (!policy) {
    return { resolved: false, score: null, explanation: null, ranking_policy_ref: rankingPolicyRef };
  }
  const result = policy({ request, seeker, helper, ranking_policy_ref: rankingPolicyRef });
  const score = typeof result === "number" ? result : result?.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return { resolved: false, score: null, explanation: result?.explanation ?? null, ranking_policy_ref: rankingPolicyRef };
  }
  return {
    resolved: true,
    score,
    explanation: typeof result === "object" ? result.explanation ?? null : null,
    ranking_policy_ref: rankingPolicyRef,
  };
}

function normalizeCapacities(request, helpers) {
  const capacities = new Map();
  const capacityRefs = new Map();
  const input = request.capacities ?? request.per_target_capacities ?? {};
  helpers.forEach((helper, index) => {
    const ref = helperRef(helper);
    let entry;
    if (Array.isArray(input)) {
      entry = input[index];
    } else {
      entry = input[ref];
    }
    const value = typeof entry === "object" && entry !== null
      ? entry.capacity ?? entry.limit
      : entry;
    const capacity = Number.isInteger(value) && value >= 0 ? value : 0;
    capacities.set(ref, capacity);
    capacityRefs.set(
      ref,
      stableString(
        (typeof entry === "object" && entry !== null ? entry.capacity_ref : null)
          ?? helper?.capacity_ref
          ?? request.capacity_refs?.[ref]
          ?? ref,
      ),
    );
  });
  return { capacities, capacityRefs };
}

function compareCandidates(left, right) {
  if (left.score !== right.score) return right.score - left.score;
  const seekerOrder = left.help_seeker_ref.localeCompare(right.help_seeker_ref);
  if (seekerOrder !== 0) return seekerOrder;
  return left.helper_candidate_ref.localeCompare(right.helper_candidate_ref);
}

export function solveCapacityConstraints(request = {}) {
  const seekers = [...(Array.isArray(request.help_seekers) ? request.help_seekers : [])]
    .sort((left, right) => matchCaseId(left).localeCompare(matchCaseId(right)));
  const helpers = [...(Array.isArray(request.helper_candidates) ? request.helper_candidates : [])]
    .sort((left, right) => helperRef(left).localeCompare(helperRef(right)));
  const { capacities, capacityRefs } = normalizeCapacities(request, helpers);
  const usage = new Map([...capacities.keys()].map((ref) => [ref, 0]));
  const candidates = [];
  const rejectedByCase = new Map(seekers.map((seeker) => [matchCaseId(seeker), []]));
  const seekerByCase = new Map(seekers.map((seeker) => [matchCaseId(seeker), seeker]));
  const helperByRef = new Map(helpers.map((helper) => [helperRef(helper), helper]));
  for (const rejection of Array.isArray(request.rejected_candidates) ? request.rejected_candidates : []) {
    for (const seeker of seekers.filter((candidate) => seekerRef(candidate) === rejection.help_seeker_ref)) {
      rejectedByCase.get(matchCaseId(seeker)).push({
        helper_candidate_ref: rejection.helper_candidate_ref ?? null,
        reason: rejection.reason ?? "candidate_rejected",
      });
    }
  }
  const hasCandidateEdges = Array.isArray(request.candidate_edges);
  let cartesianEvaluationCount = 0;
  let boundedEdgeEvaluationCount = 0;

  function addCandidate(seeker, helper, edge = null) {
    const caseId = matchCaseId(seeker);
    const helpSeekerRef = seekerRef(seeker);
    const helperCandidateRef = helperRef(helper);
    if (helpSeekerRef === helperCandidateRef) {
      rejectedByCase.get(caseId).push({
        helper_candidate_ref: helperCandidateRef,
        reason: "independent_party_self_assignment",
      });
      return;
    }
    let eligibility;
    let ranking;
    if (edge) {
      boundedEdgeEvaluationCount += 1;
      eligibility = edge.eligible === true
        ? {
            eligible: true,
            predicate_refs: Array.isArray(edge.eligibility_predicate_refs)
              ? edge.eligibility_predicate_refs.map(stableString).sort()
              : [],
            reason: null,
          }
        : evaluateEligibility(request, seeker, helper);
      const admission = expectedValueAdmission(edge, request.expected_value);
      ranking = admission.admitted
        ? {
            resolved: true,
            score: edge.expected_value,
            explanation: edge.explanation ?? null,
            ranking_policy_ref: edge.ranking_policy_ref ?? "expected-value-product",
          }
        : { resolved: false, reason: admission.reason };
    } else {
      cartesianEvaluationCount += 1;
      eligibility = evaluateEligibility(request, seeker, helper);
      ranking = evaluateRanking(request, seeker, helper);
    }
    if (!eligibility.eligible) {
      rejectedByCase.get(caseId).push({ helper_candidate_ref: helperCandidateRef, reason: eligibility.reason });
      return;
    }
    if (!ranking.resolved) {
      rejectedByCase.get(caseId).push({
        helper_candidate_ref: helperCandidateRef,
        reason: ranking.reason ?? "ranking_policy_unresolved",
      });
      return;
    }
    candidates.push({
      seeker,
      helper,
      match_case_id: caseId,
      help_seeker_ref: helpSeekerRef,
      helper_candidate_ref: helperCandidateRef,
      target_ref: helperCandidateRef,
      capacity_ref: capacityRefs.get(helperCandidateRef),
      session_ref: edge?.session_ref ?? helper?.session_ref ?? helper?.session_id ?? null,
      mode: edge?.mode ?? helper?.mode ?? helper?.mode_ref ?? null,
      eligibility_predicate_refs: eligibility.predicate_refs,
      ranking_policy_ref: ranking.ranking_policy_ref,
      score: ranking.score,
      expected_value_factors: edge?.factors ?? null,
      evidence_refs: Array.isArray(edge?.evidence_refs) ? [...edge.evidence_refs].sort() : [],
      scope: edge?.scope ?? seeker?.scope ?? null,
      scope_key: edge?.scope_key ?? needleMoverScopeKey(edge ?? seeker),
      explanation: ranking.explanation,
    });
  }

  if (hasCandidateEdges) {
    for (const edge of request.candidate_edges) {
      const seeker = seekerByCase.get(stableString(edge?.match_case_id));
      const helper = helperByRef.get(identityOf(edge, ["helper_candidate_ref", "helper_ref", "target_ref", "participant", "resource_ref"]));
      if (seeker && helper) addCandidate(seeker, helper, edge);
    }
  } else {
    for (const seeker of seekers) {
      for (const helper of helpers) addCandidate(seeker, helper);
    }
  }

  const blockedCases = new Set();
  if (hasCandidateEdges) {
    for (const seeker of seekers) {
      const caseId = matchCaseId(seeker);
      const caseCandidates = candidates.filter((candidate) => candidate.match_case_id === caseId);
      const boundary = selectionBoundary(
        caseCandidates.map((candidate) => candidate.score),
        demandOf(seeker, request),
        request.expected_value,
      );
      if (!boundary.distinguishable) {
        blockedCases.add(caseId);
        rejectedByCase.get(caseId).push({ helper_candidate_ref: null, reason: boundary.reason });
      }
    }
  }

  const selectableCandidates = candidates.filter((candidate) => !blockedCases.has(candidate.match_case_id));
  selectableCandidates.sort(compareCandidates);
  const assignmentCounts = new Map(seekers.map((seeker) => [matchCaseId(seeker), 0]));
  const assignments = [];
  for (const candidate of selectableCandidates) {
    const demand = demandOf(candidate.seeker, request);
    if ((assignmentCounts.get(candidate.match_case_id) ?? 0) >= demand) continue;
    if ((usage.get(candidate.target_ref) ?? 0) >= (capacities.get(candidate.target_ref) ?? 0)) continue;
    usage.set(candidate.target_ref, (usage.get(candidate.target_ref) ?? 0) + 1);
    assignmentCounts.set(candidate.match_case_id, (assignmentCounts.get(candidate.match_case_id) ?? 0) + 1);
    assignments.push({
      assignment_id: `assignment:${candidate.match_case_id}:${candidate.helper_candidate_ref}`,
      match_case_id: candidate.match_case_id,
      help_seeker_ref: candidate.help_seeker_ref,
      helper_candidate_ref: candidate.helper_candidate_ref,
      target_ref: candidate.target_ref,
      capacity_ref: candidate.capacity_ref,
      session_ref: candidate.session_ref,
      mode: candidate.mode,
      eligibility_predicate_refs: candidate.eligibility_predicate_refs,
      ranking_policy_ref: candidate.ranking_policy_ref,
      rank_score: candidate.score,
      expected_value_factors: candidate.expected_value_factors,
      evidence_refs: candidate.evidence_refs,
      scope: candidate.scope,
      scope_key: candidate.scope_key,
      explanation: candidate.explanation,
      state: "proposed",
    });
  }

  const eligibleByCase = new Map();
  for (const candidate of selectableCandidates) {
    if (!eligibleByCase.has(candidate.match_case_id)) eligibleByCase.set(candidate.match_case_id, []);
    eligibleByCase.get(candidate.match_case_id).push(candidate);
  }
  const unmatched = seekers
    .filter((seeker) => (assignmentCounts.get(matchCaseId(seeker)) ?? 0) < demandOf(seeker, request))
    .map((seeker) => {
      const caseId = matchCaseId(seeker);
      const ref = seekerRef(seeker);
      const eligible = eligibleByCase.get(caseId) ?? [];
      const rejections = rejectedByCase.get(caseId) ?? [];
      let reason = "no_eligible_helper";
      if (rejections.some((entry) => entry.reason === "indistinguishable_expected_value")) reason = "indistinguishable_expected_value";
      else if (rejections.some((entry) => [
        "missing_positive_expected_value_factor",
        "missing_grounded_factor_evidence",
        "non_positive_expected_value",
        "expected_value_product_mismatch",
        "needle_mover_scope_missing",
      ].includes(entry.reason))) reason = rejections.find((entry) => [
        "missing_positive_expected_value_factor",
        "missing_grounded_factor_evidence",
        "non_positive_expected_value",
        "expected_value_product_mismatch",
        "needle_mover_scope_missing",
      ].includes(entry.reason)).reason;
      else if (rejections.some((entry) => entry.reason === "insufficient_positive_candidates")) reason = "insufficient_positive_candidates";
      else if (helpers.length === 0) reason = "no_helper_candidates";
      else if (eligible.length > 0) reason = "capacity_exhausted";
      else if (rejections.some((entry) => entry.reason === "ranking_policy_unresolved")) reason = "ranking_policy_unresolved";
      return {
        match_case_id: caseId,
        help_seeker_ref: ref,
        reason,
        required_assignment_count: demandOf(seeker, request),
        assigned_count: assignmentCounts.get(caseId) ?? 0,
        considered_helper_count: helpers.length,
        eligible_helper_refs: eligible.map((entry) => entry.helper_candidate_ref).sort(),
        rejection_reasons: rejections.sort((left, right) => (
          String(left.helper_candidate_ref ?? "").localeCompare(String(right.helper_candidate_ref ?? ""))
        )),
      };
    });

  const capacityUsage = [...capacities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([targetRef, capacity]) => ({
      target_ref: targetRef,
      capacity_ref: capacityRefs.get(targetRef),
      capacity,
      assigned: usage.get(targetRef) ?? 0,
      remaining: capacity - (usage.get(targetRef) ?? 0),
    }));

  return {
    operation: "solve_capacity_constraints",
    assignments,
    unmatched,
    capacity_usage: capacityUsage,
    rejected_candidates: Array.isArray(request.rejected_candidates)
      ? request.rejected_candidates.map((entry) => ({ ...entry }))
      : [],
    instrumentation: {
      bounded_edge_evaluation_count: boundedEdgeEvaluationCount,
      cartesian_evaluation_count: cartesianEvaluationCount,
      blocked_indistinguishable_case_count: [...blockedCases].filter((caseId) => (
        rejectedByCase.get(caseId).some((entry) => entry.reason === "indistinguishable_expected_value")
      )).length,
    },
    owner_reuse_refs: [...OWNER_REUSE_REFS],
  };
}

export function proposeAssignment(request = {}) {
  const solved = Array.isArray(request.assignments) && Array.isArray(request.unmatched)
    ? request
    : solveCapacityConstraints(request);
  return {
    operation: "propose_assignment",
    proposals: solved.assignments.map((assignment) => ({ ...assignment, state: "proposed" })),
    unmatched: solved.unmatched.map((entry) => ({ ...entry })),
    capacity_usage: solved.capacity_usage?.map((entry) => ({ ...entry })) ?? [],
    owner_reuse_refs: [...OWNER_REUSE_REFS],
  };
}

export function recordOutcome(request = {}) {
  if (!request.assignment_proposal?.assignment_id) {
    throw new TypeError("record_outcome requires assignment_proposal.assignment_id");
  }
  const outcomeFactRefs = Array.isArray(request.outcome_fact_refs)
    ? [...new Set(request.outcome_fact_refs.map(stableString))].sort()
    : [];
  return {
    operation: "record_outcome",
    assignment_id: stableString(request.assignment_proposal.assignment_id),
    match_case_id: request.assignment_proposal.match_case_id ?? null,
    help_seeker_ref: request.assignment_proposal.help_seeker_ref ?? null,
    helper_candidate_ref: request.assignment_proposal.helper_candidate_ref ?? null,
    outcome_fact_refs: outcomeFactRefs,
    outcome_state: request.outcome_state ?? "recorded",
    owner_reuse_refs: [...OWNER_REUSE_REFS],
  };
}

export function executeAssignmentOperation(request = {}) {
  switch (request.operation) {
    case "solve_capacity_constraints":
      return solveCapacityConstraints(request);
    case "solve_expected_value_capacity_constraints":
      return solveCapacityConstraints(capacityRequestFromExpectedValueCandidates(
        request.candidates,
        request,
      ));
    case "propose_assignment":
      return proposeAssignment(request);
    case "record_outcome":
      return recordOutcome(request);
    default:
      throw new TypeError(`unsupported assignment operation: ${String(request.operation)}`);
  }
}

export default executeAssignmentOperation;
