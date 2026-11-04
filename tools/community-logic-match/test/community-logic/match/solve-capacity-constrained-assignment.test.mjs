// Vendored unchanged except for import paths from bitfield-packages/packages/interaction-program/do-work/solve-capacity-constrained-assignment.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capacityRequestFromExpectedValueCandidates,
  executeAssignmentOperation,
  proposeAssignment,
  recordOutcome,
  solveCapacityConstraints,
} from "../../../src/community-logic/match/solve-capacity-constrained-assignment.mjs";

const SCOPE = Object.freeze({
  pursuit_ref: "pursuit:example",
  system_ref: "system:example",
  timescale_ref: "timescale:now",
  state_ref: "state:current",
});

function factorEvidence(value) {
  const factors = {
    complementarity: value,
    relevance: 1,
    timing: 1,
    ability_to_act: 1,
    impact: 1,
  };
  return {
    status: "grounded",
    evidence_refs: ["evidence:capacity-fixture"],
    factors: Object.fromEntries(Object.entries(factors).map(([factor, score]) => [factor, {
      status: "grounded",
      score,
      evidence_refs: ["evidence:capacity-fixture"],
      inference_ref: `inference:capacity-fixture:${factor}`,
    }])),
  };
}

function expectedValueCandidate(subject, participant, value, extra = {}) {
  return {
    subject,
    participant,
    resource_ref: participant,
    expected_value: value,
    factors: {
      complementarity: value,
      relevance: 1,
      timing: 1,
      ability_to_act: 1,
      impact: 1,
    },
    factor_evidence: factorEvidence(value),
    evidence_refs: ["evidence:capacity-fixture"],
    justification_status: "grounded",
    scope: SCOPE,
    ...extra,
  };
}

function genericRequest(overrides = {}) {
  return {
    help_seekers: [
      { match_case_id: "case-1", id: "seeker-1", tier: 3 },
      { match_case_id: "case-2", id: "seeker-2", tier: 2 },
      { match_case_id: "case-3", id: "seeker-3", tier: 1 },
      { match_case_id: "case-4", id: "seeker-4", tier: 0 },
      { match_case_id: "case-5", id: "seeker-5", tier: -1 },
    ],
    helper_candidates: [
      { id: "helper-1", weight: 3 },
      { id: "helper-2", weight: 2 },
      { id: "helper-3", weight: 1 },
    ],
    capacities: [2, 1, 0],
    eligibility_predicate_refs: ["predicate:generic-access"],
    eligibility_predicates: {
      "predicate:generic-access": () => true,
    },
    ranking_policy_ref: "ranking:generic-distance",
    ranking_policies: {
      "ranking:generic-distance": ({ seeker, helper }) => ({
        score: 100 - Math.abs(seeker.tier - helper.weight),
        explanation: "generic numeric distance",
      }),
    },
    ...overrides,
  };
}

test("CAPACITY: assignments never exceed capacity and overflow is explicitly unmatched", () => {
  const result = solveCapacityConstraints(genericRequest());
  assert.equal(result.assignments.length, 3);
  assert.equal(result.unmatched.length, 2);
  for (const usage of result.capacity_usage) {
    assert.ok(usage.assigned <= usage.capacity, `${usage.target_ref} exceeded capacity`);
  }
  assert.deepEqual(
    result.unmatched.map((entry) => entry.reason),
    ["capacity_exhausted", "capacity_exhausted"],
  );
});

test("DETERMINISM: identical input produces byte-identical output repeatedly", () => {
  const request = genericRequest();
  const first = JSON.stringify(solveCapacityConstraints(request));
  const second = JSON.stringify(solveCapacityConstraints(request));
  const third = JSON.stringify(solveCapacityConstraints(request));
  assert.equal(first, second);
  assert.equal(first, third);
});

test("UNMATCHED REPORTING: no eligible helper is reported with rejection reasons", () => {
  const request = genericRequest({
    capacities: [2, 2, 1],
    eligibility_predicates: {
      "predicate:generic-access": ({ seeker }) => seeker.id === "seeker-5"
        ? { eligible: false, reason: "predicate_data_rejected" }
        : true,
    },
  });
  const result = solveCapacityConstraints(request);
  const unmatched = result.unmatched.find((entry) => entry.help_seeker_ref === "seeker-5");
  assert.ok(unmatched, "ineligible seeker must not be silently dropped");
  assert.equal(unmatched.reason, "no_eligible_helper");
  assert.equal(unmatched.rejection_reasons.length, 3);
  assert.ok(unmatched.rejection_reasons.every((entry) => entry.reason === "predicate_data_rejected"));
});

test("HOSTILE-DELETE: generic DATA remains valid and all three operations are supported", () => {
  const request = {
    operation: "solve_capacity_constraints",
    help_seekers: [
      { match_case_id: "m-02", id: "subject-b", vector: 4 },
      { match_case_id: "m-01", id: "subject-a", vector: 8 },
    ],
    helper_candidates: [
      { id: "target-y", vector: 3 },
      { id: "target-x", vector: 9 },
    ],
    per_target_capacities: { "target-x": 1, "target-y": 1 },
    eligibility_predicate_ref: "predicate:relation",
    eligibility_predicates: { "predicate:relation": () => true },
    ranking_policy_ref: "ranking:absolute-gap",
    ranking_policies: {
      "ranking:absolute-gap": ({ seeker, helper }) => -Math.abs(seeker.vector - helper.vector),
    },
  };
  const solved = executeAssignmentOperation(request);
  assert.deepEqual(
    solved.assignments.map((entry) => [entry.help_seeker_ref, entry.helper_candidate_ref]),
    [["subject-a", "target-x"], ["subject-b", "target-y"]],
  );
  assert.ok(solved.owner_reuse_refs.includes("group"));
  assert.ok(solved.owner_reuse_refs.includes("progression-evaluator"));
  assert.ok(solved.owner_reuse_refs.includes("suggested-match"));

  const proposed = proposeAssignment(solved);
  assert.equal(proposed.operation, "propose_assignment");
  assert.equal(proposed.proposals.length, 2);

  const recorded = recordOutcome({
    assignment_proposal: proposed.proposals[0],
    outcome_fact_refs: ["fact-z", "fact-a", "fact-z"],
  });
  assert.equal(recorded.operation, "record_outcome");
  assert.deepEqual(recorded.outcome_fact_refs, ["fact-a", "fact-z"]);
});

test("hybrid expected-value candidates use only bounded edges and honor scarce capacity", () => {
  const adapted = capacityRequestFromExpectedValueCandidates([
    expectedValueCandidate("seeker-a", "shared-helper", 0.9),
    expectedValueCandidate("seeker-a", "helper-a", 0.8),
    expectedValueCandidate("seeker-b", "shared-helper", 0.7, {
      scope: { ...SCOPE, pursuit_ref: "pursuit:other" },
    }),
    expectedValueCandidate("seeker-b", "helper-b", 0.6, {
      scope: { ...SCOPE, pursuit_ref: "pursuit:other" },
    }),
  ], {
    capacities: { "shared-helper": 1, "helper-a": 1, "helper-b": 1 },
    exclusive_participation: true,
  });
  const result = solveCapacityConstraints(adapted);

  assert.equal(result.assignments.length, 2);
  assert.equal(result.instrumentation.bounded_edge_evaluation_count, 4);
  assert.equal(result.instrumentation.cartesian_evaluation_count, 0);
  assert.equal(result.capacity_usage.find((entry) => entry.target_ref === "shared-helper").assigned, 1);
  assert.ok(result.assignments.every((entry) => entry.scope_key));
});

test("zero expected value produces an explicit unmatched result and no assignment", () => {
  const request = capacityRequestFromExpectedValueCandidates([
    expectedValueCandidate("seeker", "helper", 0),
  ]);
  const result = solveCapacityConstraints(request);
  assert.equal(result.assignments.length, 0);
  assert.equal(result.unmatched[0].reason, "missing_grounded_factor_evidence");
});

test("indistinguishable expected-value finalists produce no assignment", () => {
  const request = capacityRequestFromExpectedValueCandidates([
    expectedValueCandidate("seeker", "helper-a", 0.8),
    expectedValueCandidate("seeker", "helper-b", 0.8),
  ], { exclusive_participation: true });
  const result = solveCapacityConstraints(request);
  assert.equal(result.assignments.length, 0);
  assert.equal(result.unmatched[0].reason, "indistinguishable_expected_value");
  assert.equal(result.instrumentation.blocked_indistinguishable_case_count, 1);
});

test("group demand selects a distinguishable maximum compatible set", () => {
  const request = capacityRequestFromExpectedValueCandidates([
    expectedValueCandidate("seeker", "helper-a", 0.9),
    expectedValueCandidate("seeker", "helper-b", 0.8),
    expectedValueCandidate("seeker", "helper-c", 0.7),
  ], { group_size: 3 });
  const result = solveCapacityConstraints(request);
  assert.deepEqual(
    result.assignments.map((entry) => entry.helper_candidate_ref),
    ["helper-a", "helper-b"],
  );
  assert.equal(result.unmatched.length, 0);
});
