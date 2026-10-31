// Ported from the old app's test/outcome-person-confirmed.test.mjs, test/check-uses.test.mjs and
// test/outcome-trace.test.mjs (the outcome cases): how a decision turned out is read from its own evidence, the
// person's confirmed value and the AI's inference are kept side by side, and evidence of an earlier generation or a
// technical delivery never grades the current goal. `precedence` is passed in instead of flipping an imported file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentDecisionOutcome, decisionResult, decisionStatus } from '../read-data/decision-outcome.mjs';

const off = { person_confirmed_wins: false };
const on = { person_confirmed_wins: true };
const person = { result: 'met', answered_by: 'person', person_source: { basis: 'signed_in_person_screen', source_ref: 'msg:1' }, observed_at: '2026-10-01T10:00:00Z', source_ref: 'r1', summary: 'it worked' };
const check = { result: 'failed', observed_at: '2026-10-02T10:00:00Z', source_ref: 'c1', summary: 'page still shows the old text' };
const record = extra => ({ id: 'd1', decision: { }, reports: [person], observations: [check], ...extra });

test('a missing (null) decision has no outcome and no result instead of throwing', () => {
  for (const missing of [null, undefined]) {
    assert.equal(currentDecisionOutcome(missing, off), null);
    assert.equal(decisionResult(missing, off), null);
    assert.equal(decisionStatus(missing, off), undefined);
  }
});

test('by default the newest evidence is current and the person\'s value is not lost', () => {
  const outcome = currentDecisionOutcome(record(), off);
  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.inference, undefined, 'the inference is the current value, so nothing sits beside it');
});

test('with person_confirmed_wins a later check stays beside the person\'s value and does not replace it', () => {
  const outcome = currentDecisionOutcome(record(), on);
  assert.equal(outcome.result, 'met');
  assert.equal(outcome.by, 'reported');
  assert.deepEqual(outcome.inference, { result: 'failed', at: outcome.inference.at, source_ref: 'c1', summary: 'page still shows the old text' });
});

test('retracting the person\'s value (a report that supersedes it) returns the inference as current', () => {
  const retract = { result: 'unknown', answered_by: 'person', person_source: person.person_source, observed_at: '2026-10-03T10:00:00Z', source_ref: 'r2', supersedes: 'r1' };
  const outcome = currentDecisionOutcome(record({ reports: [person, retract] }), on);
  assert.notEqual(outcome.result, 'met');
  const gone = currentDecisionOutcome(record({ reports: [person, { ...retract, result: 'failed', supersedes: 'r1' }] }), on);
  assert.equal(gone.result, 'failed');
});

test('a decision result follows current evidence chronology, and uncertainty is not hidden by an older success', () => {
  assert.equal(decisionResult({}, off), null);
  assert.deepEqual(decisionResult({ reports: [{ result: 'failed', reported_at: '2026-01-01' }] }, off), { result: 'failed', at: '2026-01-01', by: 'reported' });
  assert.equal(decisionResult({ reports: [{ result: 'failed' }], outcome_checks: [{ result: 'met', checked_at: '2026-01-02' }, { result: 'unknown', checked_at: '2026-01-03' }] }, off), null);
  assert.equal(decisionResult({ reports: [{ result: 'failed', reported_at: '2026-01-03' }], outcome_checks: [{ result: 'met', checked_at: '2026-01-02' }] }, off).result, 'failed');
});

test('old or unknown generations and technical evidence cannot grade the current goal', () => {
  const decision = { decision_generation: 2, decided_at: '2026-10-02T00:00:00Z', decision: {}, status: 'outcome_verified',
    outcome_checks: [{ result: 'met', decision_generation: 1, checked_at: '2026-10-03T00:00:00Z' }],
    observations: [{ result: 'met', scope: 'technical_delivery_only', observed_at: '2026-10-03T00:00:00Z' }],
    reports: [{ result: 'met', answered_by: 'agent:test', decision_generation: 2, reported_at: '2026-10-03T00:00:00Z' }] };
  assert.equal(decisionResult(decision, off), null);
  assert.equal(decisionStatus(decision, off), 'needs_outcome');
  assert.equal(decisionResult({ ...decision, reports: [{ result: 'failed', reported_at: '2026-10-01T00:00:00Z' }] }, off), null);
});

test('a current failed check opens the decision for correction', () => {
  const decided = { decided_at: '2026-10-02T00:00:00Z', decision: { option_id: 'a' }, status: 'outcome_verified', outcome_checks: [{ result: 'failed', checked_at: '2026-10-03T00:00:00Z' }] };
  assert.equal(decisionStatus(decided, off), 'correction_needed');
  assert.equal(decisionStatus({ ...decided, outcome_checks: [{ result: 'met', checked_at: '2026-10-03T00:00:00Z' }] }, off), 'outcome_verified');
  assert.equal(decisionStatus({ status: 'needs_decision' }, off), 'needs_decision', 'an undecided decision keeps its own status');
});
