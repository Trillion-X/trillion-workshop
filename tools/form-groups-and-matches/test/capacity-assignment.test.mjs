// Helpers assigned within their capacity. Carried from the original package's capacity tests (eight cases) and its
// event-assignment gauntlet (five cases). The old requests passed eligibility and ranking as functions; a JSON tool
// takes them as answers about pairs, so each test works its answers out with the same function the old test used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityRequestFromExpectedValueCandidates, executeAssignmentOperation, proposeAssignment, recordOutcome, solveCapacityConstraints } from '../read-data/capacity-assignment.mjs';
import { candidate, OTHER_SCOPE, POLICY } from './match-fixtures.mjs';

const idOf = entry => entry.id;
/** Eligibility and ranking answers for every seeker and helper pair, from two functions. */
function answers(seekers, helpers, eligible, rank) {
  const pairs = seekers.flatMap(seeker => helpers.map(helper => ({ seeker, helper })));
  return {
    eligibility: pairs.map(({ seeker, helper }) => {
      const verdict = eligible({ seeker, helper });
      return { help_seeker_ref: idOf(seeker), helper_candidate_ref: idOf(helper), eligible: verdict === true || verdict?.eligible === true, ...(verdict?.reason ? { reason: verdict.reason } : {}) };
    }),
    ranking: pairs.map(({ seeker, helper }) => {
      const ranked = rank({ seeker, helper });
      return { help_seeker_ref: idOf(seeker), helper_candidate_ref: idOf(helper), ...(typeof ranked === 'number' ? { score: ranked } : ranked) };
    }),
  };
}

const SEEKERS = [
  { match_case_id: 'case-1', id: 'seeker-1', tier: 3 }, { match_case_id: 'case-2', id: 'seeker-2', tier: 2 }, { match_case_id: 'case-3', id: 'seeker-3', tier: 1 },
  { match_case_id: 'case-4', id: 'seeker-4', tier: 0 }, { match_case_id: 'case-5', id: 'seeker-5', tier: -1 },
];
const HELPERS = [{ id: 'helper-1', weight: 3 }, { id: 'helper-2', weight: 2 }, { id: 'helper-3', weight: 1 }];
const distance = ({ seeker, helper }) => ({ score: 100 - Math.abs(seeker.tier - helper.weight), explanation: 'numeric distance' });
const request = (eligible = () => true, overrides = {}) => ({
  help_seekers: SEEKERS, helper_candidates: HELPERS, capacities: [2, 1, 0],
  eligibility_predicate_refs: ['predicate:open-to-all'], ranking_policy_ref: 'ranking:distance',
  ...answers(SEEKERS, HELPERS, eligible, distance), ...overrides,
});

test('assignments never pass a capacity and the overflow is listed', () => {
  const result = solveCapacityConstraints(request());
  assert.equal(result.assignments.length, 3);
  assert.equal(result.unmatched.length, 2);
  for (const usage of result.capacity_usage) assert.ok(usage.assigned <= usage.capacity, `${usage.target_ref} passed its capacity`);
  assert.deepEqual(result.unmatched.map(entry => entry.reason), ['capacity_exhausted', 'capacity_exhausted']);
  assert.deepEqual(result.assignments[0].eligibility_predicate_refs, ['predicate:open-to-all']);
  assert.equal(result.assignments[0].ranking_policy_ref, 'ranking:distance');
});

test('the same input gives the same bytes every time', () => {
  const first = JSON.stringify(solveCapacityConstraints(request()));
  assert.equal(JSON.stringify(solveCapacityConstraints(request())), first);
  assert.equal(JSON.stringify(solveCapacityConstraints(request())), first);
});

test('a seeker nobody may help is listed with every reason', () => {
  const result = solveCapacityConstraints(request(({ seeker }) => (seeker.id === 'seeker-5' ? { eligible: false, reason: 'not-a-member-yet' } : true), { capacities: [2, 2, 1] }));
  const unmatched = result.unmatched.find(entry => entry.help_seeker_ref === 'seeker-5');
  assert.ok(unmatched, 'an ineligible seeker is never dropped');
  assert.equal(unmatched.reason, 'no_eligible_helper');
  assert.equal(unmatched.rejection_reasons.length, 3);
  assert.ok(unmatched.rejection_reasons.every(entry => entry.reason === 'not-a-member-yet'));
});

test('any labels work, and solve, propose and record outcome all run', () => {
  const seekers = [{ match_case_id: 'm-02', id: 'subject-b', vector: 4 }, { match_case_id: 'm-01', id: 'subject-a', vector: 8 }];
  const helpers = [{ id: 'target-y', vector: 3 }, { id: 'target-x', vector: 9 }];
  const solved = executeAssignmentOperation({
    operation: 'solve_capacity_constraints', help_seekers: seekers, helper_candidates: helpers, capacities: { 'target-x': 1, 'target-y': 1 },
    ...answers(seekers, helpers, () => true, ({ seeker, helper }) => -Math.abs(seeker.vector - helper.vector)),
  });
  assert.deepEqual(solved.assignments.map(entry => [entry.help_seeker_ref, entry.helper_candidate_ref]), [['subject-a', 'target-x'], ['subject-b', 'target-y']]);
  const proposed = proposeAssignment(solved);
  assert.equal(proposed.operation, 'propose_assignment');
  assert.equal(proposed.proposals.length, 2);
  const recorded = recordOutcome({ assignment_proposal: proposed.proposals[0], outcome_fact_refs: ['fact-z', 'fact-a', 'fact-z'] });
  assert.equal(recorded.operation, 'record_outcome');
  assert.deepEqual(recorded.outcome_fact_refs, ['fact-a', 'fact-z']);
  assert.throws(() => executeAssignmentOperation({ operation: 'guess' }), /operation must be one of/);
});

test('scored candidates use only their own edges and respect a scarce helper', () => {
  const adapted = capacityRequestFromExpectedValueCandidates([
    candidate('seeker-a', 'shared-helper', 0.9), candidate('seeker-a', 'helper-a', 0.8),
    candidate('seeker-b', 'shared-helper', 0.7, { scope: OTHER_SCOPE, scope_key: null }), candidate('seeker-b', 'helper-b', 0.6, { scope: OTHER_SCOPE, scope_key: null }),
  ], { expected_value: POLICY, capacities: { 'shared-helper': 1, 'helper-a': 1, 'helper-b': 1 }, exclusive_participation: true });
  const result = solveCapacityConstraints(adapted);
  assert.equal(result.assignments.length, 2);
  assert.equal(result.instrumentation.bounded_edge_evaluation_count, 4);
  assert.equal(result.instrumentation.cartesian_evaluation_count, 0);
  assert.equal(result.capacity_usage.find(entry => entry.target_ref === 'shared-helper').assigned, 1);
  assert.ok(result.assignments.every(entry => entry.scope_key));
});

test('a zero expected value is listed and assigns nobody', () => {
  const result = solveCapacityConstraints(capacityRequestFromExpectedValueCandidates([candidate('seeker', 'helper', 0)], { expected_value: POLICY }));
  assert.equal(result.assignments.length, 0);
  assert.equal(result.unmatched[0].reason, 'missing_grounded_factor_evidence');
});

test('equal finalists assign nobody', () => {
  const result = solveCapacityConstraints(capacityRequestFromExpectedValueCandidates([candidate('seeker', 'helper-a', 0.8), candidate('seeker', 'helper-b', 0.8)], { expected_value: POLICY, exclusive_participation: true }));
  assert.equal(result.assignments.length, 0);
  assert.equal(result.unmatched[0].reason, 'indistinguishable_expected_value');
  assert.equal(result.instrumentation.blocked_indistinguishable_case_count, 1);
});

test('a group demand takes the clearly best helpers', () => {
  const result = solveCapacityConstraints(capacityRequestFromExpectedValueCandidates([
    candidate('seeker', 'helper-a', 0.9), candidate('seeker', 'helper-b', 0.8), candidate('seeker', 'helper-c', 0.7),
  ], { expected_value: POLICY, group_size: 3 }));
  assert.deepEqual(result.assignments.map(entry => entry.helper_candidate_ref), ['helper-a', 'helper-b']);
  assert.equal(result.unmatched.length, 0);
});

// A round of a helping event: everyone may help everyone, a person ranks highest with themself (which must never be
// assigned), otherwise by how close the lengths of their ids are.
function round(roundRef, seekerIds, helperIds) {
  const seekers = seekerIds.map(id => ({ id, match_case_id: `${roundRef}:${id}` }));
  const helpers = helperIds.map(id => ({ id, session_ref: roundRef }));
  return {
    help_seekers: seekers, helper_candidates: helpers, capacities: Object.fromEntries(helperIds.map(id => [id, 1])),
    ...answers(seekers, helpers, () => true, ({ seeker, helper }) => (seeker.id === helper.id ? 1_000 : 100 - Math.abs(seeker.id.length - helper.id.length))),
  };
}
function assertNoOverbooking(result) {
  const booked = new Map();
  for (const assignment of result.assignments) {
    const key = `${assignment.session_ref}|${assignment.helper_candidate_ref}`;
    booked.set(key, (booked.get(key) ?? 0) + 1);
  }
  for (const [key, count] of booked) assert.ok(count <= 1, `${key} was booked ${count} times`);
  for (const usage of result.capacity_usage) assert.ok(usage.assigned <= usage.capacity, `${usage.target_ref} passed its capacity`);
}

test('a helper is never booked twice in one round', () => {
  const result = solveCapacityConstraints(round('round:hour-1', ['seeker:a', 'seeker:b', 'seeker:c'], ['helper:x', 'helper:y']));
  assertNoOverbooking(result);
  assert.equal(result.assignments.length, 2);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].reason, 'capacity_exhausted');
});

test('who sought help in one round can help in the next, neither round overbooked', () => {
  const seekers = ['person:a', 'person:b'];
  const helpers = ['person:c', 'person:d'];
  const hour1 = solveCapacityConstraints(round('round:hour-1', seekers, helpers));
  const hour2 = solveCapacityConstraints(round('round:hour-2', helpers, seekers));
  assertNoOverbooking(hour1);
  assertNoOverbooking(hour2);
  assert.deepEqual(new Set(hour1.assignments.map(entry => entry.help_seeker_ref)), new Set(seekers));
  assert.deepEqual(new Set(hour1.assignments.map(entry => entry.helper_candidate_ref)), new Set(helpers));
  assert.deepEqual(new Set(hour2.assignments.map(entry => entry.help_seeker_ref)), new Set(helpers));
  assert.deepEqual(new Set(hour2.assignments.map(entry => entry.helper_candidate_ref)), new Set(seekers));
});

test('nobody is assigned to help themself', () => {
  const result = solveCapacityConstraints(round('round:self', ['person:same'], ['person:same', 'person:other']));
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].helper_candidate_ref, 'person:other');
});

test('shuffled input replays to the same bytes', () => {
  const base = round('round:any-open-string', ['person:a', 'person:b', 'person:c'], ['person:x', 'person:y', 'person:z']);
  const expected = JSON.stringify(solveCapacityConstraints(base));
  assert.equal(JSON.stringify(solveCapacityConstraints({ ...base, help_seekers: [...base.help_seekers].reverse(), helper_candidates: [...base.helper_candidates].reverse() })), expected);
});

test('hostile round and person labels make no branch', () => {
  const result = solveCapacityConstraints(round('round:Friday|not-hardcoded\u0000', ['founder', 'doctor', 'mother'], ['minister', 'salesperson', 'Alder\nDROP TABLE']));
  assertNoOverbooking(result);
  assert.equal(result.assignments.length, 3);
  assert.deepEqual(new Set(result.assignments.map(entry => entry.help_seeker_ref)), new Set(['founder', 'doctor', 'mother']));
});

test('a pair with no answers is not assigned, and says which answer is missing', () => {
  const result = solveCapacityConstraints({ help_seekers: [{ id: 'a' }], helper_candidates: [{ id: 'b' }], capacities: { b: 1 } });
  assert.equal(result.assignments.length, 0);
  assert.deepEqual(result.unmatched[0].rejection_reasons.map(entry => entry.reason), ['eligibility_missing']);
});
