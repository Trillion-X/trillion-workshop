// tools/form-groups-and-matches/read-data/capacity-assignment.mjs
//
// Assign helpers to the people (or cases) who need them when helpers are scarce: every helper has a capacity, every
// seeker a demand (how many helpers), and the best-ranked eligible pairs are taken first. A helper is never booked past
// its capacity, a person is never assigned to themself, and every seeker left short is listed with the reason.
// Rounds that reverse (who helped in one round seeks in the next) are two requests with their own sessions.
//
// Who may help whom and how well are the caller's answers, given as data:
//
//   { help_seekers: [{ id | help_seeker_ref, match_case_id?, demand?, scope? }],
//     helper_candidates: [{ id | helper_candidate_ref, capacity_ref?, session_ref?, mode? }],
//     capacities: { "<helper>": n | { capacity, capacity_ref? } } | [n, ...] (in helper order),
//     eligibility: [{ help_seeker_ref, helper_candidate_ref, eligible, reason? }],
//     ranking: [{ help_seeker_ref, helper_candidate_ref, score, explanation? }],
//     eligibility_predicate_refs?: [..], ranking_policy_ref?: "..."   carried on each assignment as where its answers came from
//   }
//
// or, from scored candidates (read-data/expected-value.mjs), candidate_edges whose value is their grounded expected
// value; then the cut after each seeker's demand must be clear, as for groups.
import { expectedValueAdmission, readPolicy, scopeKey, selectionBoundary } from './expected-value.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}

const stableString = value => (typeof value === 'string' ? value : JSON.stringify(canonicalize(value)));

function identityOf(value, fields) {
  if (value == null) return null;
  if (typeof value !== 'object') return String(value);
  for (const field of fields) if (value[field] != null) return stableString(value[field]);
  return stableString(value);
}

const seekerRef = seeker => identityOf(seeker, ['help_seeker_ref', 'seeker_ref', 'participant_ref', 'id', 'ref']);
const helperRef = helper => identityOf(helper, ['helper_candidate_ref', 'helper_ref', 'target_ref', 'participant_ref', 'id', 'ref']);
const matchCaseId = seeker => (object(seeker) && seeker.match_case_id != null ? stableString(seeker.match_case_id) : `match-case:${seekerRef(seeker)}`);
const pairKey = (seeker, helper) => JSON.stringify([stableString(seeker), stableString(helper)]);

function demandOf(seeker, request) {
  const value = seeker?.demand ?? seeker?.required_assignment_count ?? request.default_demand;
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function capacityEntry(input, ref, index) {
  const entry = Array.isArray(input) ? input[index] : (object(input) && Object.hasOwn(input, ref) ? input[ref] : undefined);
  const value = object(entry) ? entry.capacity ?? entry.limit : entry;
  return { capacity: Number.isInteger(value) && value >= 0 ? value : undefined, capacity_ref: object(entry) ? entry.capacity_ref : undefined };
}

/** Scored candidates (subject, participant, grounded expected value) as a capacity request with one case per scope. */
export function capacityRequestFromExpectedValueCandidates(inputCandidates, request) {
  const policy = readPolicy(request?.expected_value);
  const candidates = Array.isArray(inputCandidates) ? inputCandidates : [];
  const admitted = [];
  const rejected = [];
  const cases = new Map();
  const helpers = new Map();
  const helperEdgeCounts = new Map();
  const requiredAssignments = Number.isInteger(request.group_size) && request.group_size >= 2 ? request.group_size - 1 : 1;

  for (const candidate of candidates) {
    const helpSeekerRef = typeof candidate?.subject === 'string' && candidate.subject.length > 0 ? candidate.subject : null;
    const helperValue = candidate?.resource_ref ?? candidate?.participant;
    const helperCandidateRef = typeof helperValue === 'string' && helperValue.length > 0 ? helperValue : null;
    const key = candidate?.scope_key ?? scopeKey(candidate, policy);
    const caseId = helpSeekerRef && key ? `match-case:${key}:${helpSeekerRef}` : null;
    if (caseId && !cases.has(caseId)) cases.set(caseId, { match_case_id: caseId, help_seeker_ref: helpSeekerRef, scope: candidate.scope, demand: requiredAssignments });
    const admission = expectedValueAdmission(candidate, policy);
    if (!admission.admitted || !caseId || !helperCandidateRef) {
      rejected.push({ help_seeker_ref: helpSeekerRef, helper_candidate_ref: helperCandidateRef, reason: admission.reason ?? 'candidate_identity_missing' });
      continue;
    }
    if (!helpers.has(helperCandidateRef)) helpers.set(helperCandidateRef, { helper_candidate_ref: helperCandidateRef, capacity_ref: candidate.capacity_ref ?? helperCandidateRef });
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
      scope_key: key,
      eligible: true,
      eligibility_predicate_refs: candidate.eligibility_predicate_refs ?? [],
      ranking_policy_ref: 'expected-value-product',
      explanation: candidate.why ?? null,
      session_ref: candidate.session_ref ?? null,
      mode: candidate.mode ?? null,
    });
  }
  const source = request.capacities ?? {};
  const capacities = Object.fromEntries([...helpers.keys()].map((ref, index) => {
    const explicit = capacityEntry(source, ref, index).capacity;
    return [ref, { capacity: explicit ?? (request.exclusive_participation === true ? 1 : helperEdgeCounts.get(ref)), capacity_ref: helpers.get(ref).capacity_ref }];
  }));
  return {
    operation: 'solve_capacity_constraints',
    help_seekers: [...cases.values()],
    helper_candidates: [...helpers.values()],
    capacities,
    candidate_edges: admitted,
    expected_value: policy,
    rejected_candidates: rejected,
  };
}

// The caller's answers about pairs, looked up by seeker and helper.
function pairAnswers(list) {
  const answers = new Map();
  for (const entry of Array.isArray(list) ? list : []) {
    if (object(entry) && entry.help_seeker_ref != null && entry.helper_candidate_ref != null) {
      answers.set(pairKey(entry.help_seeker_ref, entry.helper_candidate_ref), entry);
    }
  }
  return answers;
}

function predicateRefs(request, seeker, helper) {
  const refs = [
    ...(Array.isArray(request.eligibility_predicate_refs) ? request.eligibility_predicate_refs : []),
    request.eligibility_predicate_ref, seeker?.eligibility_predicate_ref, helper?.eligibility_predicate_ref,
  ].filter(value => value != null);
  return [...new Set(refs.map(stableString))].sort();
}

const compareCandidates = (left, right) => (left.score !== right.score ? right.score - left.score
  : left.help_seeker_ref.localeCompare(right.help_seeker_ref) || left.helper_candidate_ref.localeCompare(right.helper_candidate_ref));

const VALUE_REASONS = ['missing_grounded_factor_evidence', 'non_positive_expected_value', 'expected_value_product_mismatch', 'scope_missing'];

export function solveCapacityConstraints(request) {
  const hasCandidateEdges = Array.isArray(request.candidate_edges);
  const policy = hasCandidateEdges ? readPolicy(request.expected_value) : (object(request.expected_value) ? request.expected_value : {});
  const seekers = [...(Array.isArray(request.help_seekers) ? request.help_seekers : [])].sort((left, right) => matchCaseId(left).localeCompare(matchCaseId(right)));
  const helpers = [...(Array.isArray(request.helper_candidates) ? request.helper_candidates : [])].sort((left, right) => helperRef(left).localeCompare(helperRef(right)));
  const capacities = new Map();
  const capacityRefs = new Map();
  helpers.forEach((helper, index) => {
    const ref = helperRef(helper);
    const entry = capacityEntry(request.capacities ?? {}, ref, index);
    capacities.set(ref, entry.capacity ?? 0);
    capacityRefs.set(ref, stableString(entry.capacity_ref ?? helper?.capacity_ref ?? ref));
  });
  const eligibility = pairAnswers(request.eligibility);
  const ranking = pairAnswers(request.ranking);
  const usage = new Map([...capacities.keys()].map(ref => [ref, 0]));
  const candidates = [];
  const rejectedByCase = new Map(seekers.map(seeker => [matchCaseId(seeker), []]));
  const seekerByCase = new Map(seekers.map(seeker => [matchCaseId(seeker), seeker]));
  const helperByRef = new Map(helpers.map(helper => [helperRef(helper), helper]));
  for (const rejection of Array.isArray(request.rejected_candidates) ? request.rejected_candidates : []) {
    for (const seeker of seekers.filter(candidate => seekerRef(candidate) === rejection.help_seeker_ref)) {
      rejectedByCase.get(matchCaseId(seeker)).push({ helper_candidate_ref: rejection.helper_candidate_ref ?? null, reason: rejection.reason ?? 'candidate_rejected' });
    }
  }
  let cartesianEvaluationCount = 0;
  let boundedEdgeEvaluationCount = 0;

  function addCandidate(seeker, helper, edge = null) {
    const caseId = matchCaseId(seeker);
    const helpSeekerRef = seekerRef(seeker);
    const helperCandidateRef = helperRef(helper);
    if (helpSeekerRef === helperCandidateRef) {
      rejectedByCase.get(caseId).push({ helper_candidate_ref: helperCandidateRef, reason: 'independent_party_self_assignment' });
      return;
    }
    let decision;
    let rank;
    if (edge) {
      boundedEdgeEvaluationCount += 1;
      decision = edge.eligible === true
        ? { eligible: true, predicate_refs: Array.isArray(edge.eligibility_predicate_refs) ? edge.eligibility_predicate_refs.map(stableString).sort() : [], reason: null }
        : null;
      const admission = expectedValueAdmission(edge, policy);
      rank = admission.admitted
        ? { resolved: true, score: edge.expected_value, explanation: edge.explanation ?? null, ranking_policy_ref: edge.ranking_policy_ref ?? 'expected-value-product' }
        : { resolved: false, reason: admission.reason };
    } else {
      cartesianEvaluationCount += 1;
    }
    const key = pairKey(helpSeekerRef, helperCandidateRef);
    if (!decision) {
      const answer = eligibility.get(key);
      decision = !answer
        ? { eligible: false, reason: 'eligibility_missing' }
        : { eligible: answer.eligible === true, predicate_refs: predicateRefs(request, seeker, helper), reason: answer.eligible === true ? null : answer.reason ?? 'eligibility_rejected' };
    }
    if (!rank) {
      const answer = ranking.get(key);
      rank = answer && Number.isFinite(answer.score)
        ? { resolved: true, score: answer.score, explanation: answer.explanation ?? null, ranking_policy_ref: request.ranking_policy_ref ?? null }
        : { resolved: false, reason: 'ranking_missing' };
    }
    if (!decision.eligible) {
      rejectedByCase.get(caseId).push({ helper_candidate_ref: helperCandidateRef, reason: decision.reason });
      return;
    }
    if (!rank.resolved) {
      rejectedByCase.get(caseId).push({ helper_candidate_ref: helperCandidateRef, reason: rank.reason });
      return;
    }
    candidates.push({
      seeker,
      match_case_id: caseId,
      help_seeker_ref: helpSeekerRef,
      helper_candidate_ref: helperCandidateRef,
      capacity_ref: capacityRefs.get(helperCandidateRef),
      session_ref: edge?.session_ref ?? helper?.session_ref ?? null,
      mode: edge?.mode ?? helper?.mode ?? null,
      eligibility_predicate_refs: decision.predicate_refs,
      ranking_policy_ref: rank.ranking_policy_ref,
      score: rank.score,
      expected_value_factors: edge?.factors ?? null,
      evidence_refs: Array.isArray(edge?.evidence_refs) ? [...edge.evidence_refs].sort() : [],
      scope: edge?.scope ?? seeker?.scope ?? null,
      scope_key: edge?.scope_key ?? (policy.scope_fields ? scopeKey(edge ?? seeker, policy) : null),
      explanation: rank.explanation,
    });
  }

  if (hasCandidateEdges) {
    for (const edge of request.candidate_edges) {
      const seeker = seekerByCase.get(stableString(edge?.match_case_id));
      const helper = helperByRef.get(identityOf(edge, ['helper_candidate_ref', 'helper_ref', 'target_ref', 'participant', 'resource_ref']));
      if (seeker && helper) addCandidate(seeker, helper, edge);
    }
  } else {
    for (const seeker of seekers) for (const helper of helpers) addCandidate(seeker, helper);
  }

  const blockedCases = new Set();
  if (hasCandidateEdges) {
    for (const seeker of seekers) {
      const caseId = matchCaseId(seeker);
      const boundary = selectionBoundary(candidates.filter(candidate => candidate.match_case_id === caseId).map(candidate => candidate.score), demandOf(seeker, request), policy);
      if (!boundary.distinguishable) {
        blockedCases.add(caseId);
        rejectedByCase.get(caseId).push({ helper_candidate_ref: null, reason: boundary.reason });
      }
    }
  }

  const selectable = candidates.filter(candidate => !blockedCases.has(candidate.match_case_id)).sort(compareCandidates);
  const assignmentCounts = new Map(seekers.map(seeker => [matchCaseId(seeker), 0]));
  const assignments = [];
  for (const candidate of selectable) {
    if ((assignmentCounts.get(candidate.match_case_id) ?? 0) >= demandOf(candidate.seeker, request)) continue;
    const target = candidate.helper_candidate_ref;
    if ((usage.get(target) ?? 0) >= (capacities.get(target) ?? 0)) continue;
    usage.set(target, (usage.get(target) ?? 0) + 1);
    assignmentCounts.set(candidate.match_case_id, (assignmentCounts.get(candidate.match_case_id) ?? 0) + 1);
    assignments.push({
      assignment_id: `assignment:${candidate.match_case_id}:${target}`,
      match_case_id: candidate.match_case_id,
      help_seeker_ref: candidate.help_seeker_ref,
      helper_candidate_ref: target,
      target_ref: target,
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
      state: 'proposed',
    });
  }

  const eligibleByCase = new Map();
  for (const candidate of selectable) {
    if (!eligibleByCase.has(candidate.match_case_id)) eligibleByCase.set(candidate.match_case_id, []);
    eligibleByCase.get(candidate.match_case_id).push(candidate);
  }
  const unmatched = seekers
    .filter(seeker => (assignmentCounts.get(matchCaseId(seeker)) ?? 0) < demandOf(seeker, request))
    .map(seeker => {
      const caseId = matchCaseId(seeker);
      const eligible = eligibleByCase.get(caseId) ?? [];
      const rejections = rejectedByCase.get(caseId) ?? [];
      const valueReason = rejections.find(entry => VALUE_REASONS.includes(entry.reason))?.reason;
      let reason = 'no_eligible_helper';
      if (rejections.some(entry => entry.reason === 'indistinguishable_expected_value')) reason = 'indistinguishable_expected_value';
      else if (valueReason) reason = valueReason;
      else if (rejections.some(entry => entry.reason === 'insufficient_positive_candidates')) reason = 'insufficient_positive_candidates';
      else if (helpers.length === 0) reason = 'no_helper_candidates';
      else if (eligible.length > 0) reason = 'capacity_exhausted';
      else if (rejections.some(entry => entry.reason === 'ranking_missing')) reason = 'ranking_missing';
      return {
        match_case_id: caseId,
        help_seeker_ref: seekerRef(seeker),
        reason,
        required_assignment_count: demandOf(seeker, request),
        assigned_count: assignmentCounts.get(caseId) ?? 0,
        considered_helper_count: helpers.length,
        eligible_helper_refs: eligible.map(entry => entry.helper_candidate_ref).sort(),
        rejection_reasons: rejections.sort((left, right) => String(left.helper_candidate_ref ?? '').localeCompare(String(right.helper_candidate_ref ?? ''))),
      };
    });

  return {
    operation: 'solve_capacity_constraints',
    assignments,
    unmatched,
    capacity_usage: [...capacities.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([targetRef, capacity]) => ({
      target_ref: targetRef, capacity_ref: capacityRefs.get(targetRef), capacity, assigned: usage.get(targetRef) ?? 0, remaining: capacity - (usage.get(targetRef) ?? 0),
    })),
    rejected_candidates: Array.isArray(request.rejected_candidates) ? request.rejected_candidates.map(entry => ({ ...entry })) : [],
    instrumentation: {
      bounded_edge_evaluation_count: boundedEdgeEvaluationCount,
      cartesian_evaluation_count: cartesianEvaluationCount,
      blocked_indistinguishable_case_count: [...blockedCases].filter(caseId => rejectedByCase.get(caseId).some(entry => entry.reason === 'indistinguishable_expected_value')).length,
    },
  };
}

/** Assignments as proposals, from a solved answer or by solving the request. */
export function proposeAssignment(request) {
  const solved = Array.isArray(request.assignments) && Array.isArray(request.unmatched) ? request : solveCapacityConstraints(request);
  return {
    operation: 'propose_assignment',
    proposals: solved.assignments.map(assignment => ({ ...assignment, state: 'proposed' })),
    unmatched: solved.unmatched.map(entry => ({ ...entry })),
    capacity_usage: solved.capacity_usage?.map(entry => ({ ...entry })) ?? [],
  };
}

/** What came of one proposal: the facts that record its outcome, sorted and without repeats. */
export function recordOutcome(request) {
  if (!request.assignment_proposal?.assignment_id) throw new Error('record_outcome needs assignment_proposal.assignment_id.');
  return {
    operation: 'record_outcome',
    assignment_id: stableString(request.assignment_proposal.assignment_id),
    match_case_id: request.assignment_proposal.match_case_id ?? null,
    help_seeker_ref: request.assignment_proposal.help_seeker_ref ?? null,
    helper_candidate_ref: request.assignment_proposal.helper_candidate_ref ?? null,
    outcome_fact_refs: Array.isArray(request.outcome_fact_refs) ? [...new Set(request.outcome_fact_refs.map(stableString))].sort() : [],
    outcome_state: request.outcome_state ?? 'recorded',
  };
}

export const ASSIGNMENT_OPERATIONS = Object.freeze({
  solve_capacity_constraints: solveCapacityConstraints,
  solve_expected_value_capacity_constraints: request => solveCapacityConstraints(capacityRequestFromExpectedValueCandidates(request.candidates, request)),
  propose_assignment: proposeAssignment,
  record_outcome: recordOutcome,
});

export function executeAssignmentOperation(request) {
  const operation = request?.operation;
  if (typeof operation !== 'string' || !Object.hasOwn(ASSIGNMENT_OPERATIONS, operation)) {
    throw new Error(`operation must be one of ${Object.keys(ASSIGNMENT_OPERATIONS).join(', ')}.`);
  }
  return ASSIGNMENT_OPERATIONS[operation](request);
}
