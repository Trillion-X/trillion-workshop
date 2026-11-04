// Vendored from bitfield-packages/packages/interaction-program/tests/event-assignment-gauntlet.test.mjs; only import paths changed (and the select-pairs-cli process mount test dropped, since Trillion forms introductions in src/community-matching.mjs instead of a process mount).
import { test } from "node:test";
import assert from "node:assert/strict";

let assignmentModule = null;
let assignmentLoadError = null;
try {
  assignmentModule = await import("../../../src/community-logic/match/solve-capacity-constrained-assignment.mjs");
} catch (error) {
  assignmentLoadError = error;
}
const assignmentTestOptions = assignmentModule
  ? {}
  : { skip: "blocked by missing capacity-constrained assignment owner" };

function requireSolver() {
  assert.ok(
    assignmentModule && typeof assignmentModule.solveCapacityConstraints === "function",
    `capacity-constrained assignment owner is required: ${assignmentLoadError?.message ?? "export missing"}`,
  );
  return assignmentModule.solveCapacityConstraints;
}

function roundRequest(roundRef, seekers, helpers) {
  return {
    help_seekers: seekers.map((id) => ({ id, match_case_id: `${roundRef}:${id}` })),
    helper_candidates: helpers.map((id) => ({ id, session_ref: roundRef })),
    capacities: Object.fromEntries(helpers.map((id) => [id, 1])),
    eligibility_predicate_ref: "predicate:consented-for-round",
    eligibility_predicates: { "predicate:consented-for-round": () => true },
    ranking_policy_ref: "ranking:deterministic-round",
    ranking_policies: {
      "ranking:deterministic-round": ({ seeker, helper }) => ({
        score: seeker.id === helper.id ? 1_000 : 100 - Math.abs(seeker.id.length - helper.id.length),
        explanation: "generic deterministic fixture ranking",
      }),
    },
  };
}

function assertNoOverbooking(result) {
  const byRoundAndHelper = new Map();
  for (const assignment of result.assignments) {
    const key = `${assignment.session_ref}|${assignment.helper_candidate_ref}`;
    byRoundAndHelper.set(key, (byRoundAndHelper.get(key) ?? 0) + 1);
  }
  for (const [key, count] of byRoundAndHelper) {
    assert.ok(count <= 1, `${key} was booked ${count} times`);
  }
  for (const usage of result.capacity_usage) {
    assert.ok(usage.assigned <= usage.capacity, `${usage.target_ref} exceeded capacity`);
  }
}

test("OWNER / INTEGRATION: generic capacity-constrained assignment owner exists", () => {
  requireSolver();
});

test("CAPACITY: a helper is never booked twice in the same hour", assignmentTestOptions, () => {
  const solveCapacityConstraints = requireSolver();
  const result = solveCapacityConstraints(roundRequest(
    "round:hour-1",
    ["seeker:a", "seeker:b", "seeker:c"],
    ["helper:x", "helper:y"],
  ));
  assertNoOverbooking(result);
  assert.equal(result.assignments.length, 2);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].reason, "capacity_exhausted");
});

test("REVERSAL: hour-1 seekers become hour-2 helpers without overbooking either round", assignmentTestOptions, () => {
  const solveCapacityConstraints = requireSolver();
  const firstSeekers = ["person:a", "person:b"];
  const firstHelpers = ["person:c", "person:d"];
  const hour1 = solveCapacityConstraints(roundRequest("round:hour-1", firstSeekers, firstHelpers));
  const hour2 = solveCapacityConstraints(roundRequest("round:hour-2", firstHelpers, firstSeekers));

  assertNoOverbooking(hour1);
  assertNoOverbooking(hour2);
  assert.equal(hour1.assignments.length, 2);
  assert.equal(hour2.assignments.length, 2);
  assert.deepEqual(new Set(hour1.assignments.map((entry) => entry.help_seeker_ref)), new Set(firstSeekers));
  assert.deepEqual(new Set(hour1.assignments.map((entry) => entry.helper_candidate_ref)), new Set(firstHelpers));
  assert.deepEqual(new Set(hour2.assignments.map((entry) => entry.help_seeker_ref)), new Set(firstHelpers));
  assert.deepEqual(new Set(hour2.assignments.map((entry) => entry.helper_candidate_ref)), new Set(firstSeekers));
});

test("INDEPENDENT PARTIES: the same person can never help themself", assignmentTestOptions, () => {
  const solveCapacityConstraints = requireSolver();
  const result = solveCapacityConstraints(roundRequest(
    "round:self-match-adversary",
    ["person:same"],
    ["person:same", "person:other"],
  ));
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].helper_candidate_ref, "person:other");
  assert.notEqual(
    result.assignments[0].help_seeker_ref,
    result.assignments[0].helper_candidate_ref,
  );
});

test("DETERMINISM: shuffled round inputs replay byte-identically", assignmentTestOptions, () => {
  const solveCapacityConstraints = requireSolver();
  const base = roundRequest(
    "round:any-open-string",
    ["person:a", "person:b", "person:c"],
    ["person:x", "person:y", "person:z"],
  );
  const expected = JSON.stringify(solveCapacityConstraints(base));
  const replay = solveCapacityConstraints({
    ...base,
    help_seekers: [...base.help_seekers].reverse(),
    helper_candidates: [...base.helper_candidates].reverse(),
  });
  assert.equal(JSON.stringify(replay), expected);
});

test("GENERICITY / HOSTILE DATA: round, person, and persona labels do not create branches", assignmentTestOptions, () => {
  const solveCapacityConstraints = requireSolver();
  const result = solveCapacityConstraints(roundRequest(
    "round:Friday<script>|not-hardcoded",
    ["founder", "doctor", "mother"],
    ["minister", "salesperson", "Lee\nDROP TABLE"],
  ));
  assertNoOverbooking(result);
  assert.equal(result.assignments.length, 3);
  assert.deepEqual(
    new Set(result.assignments.map((entry) => entry.help_seeker_ref)),
    new Set(["founder", "doctor", "mother"]),
  );
});
