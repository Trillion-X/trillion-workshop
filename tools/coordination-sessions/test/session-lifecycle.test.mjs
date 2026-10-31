// The lifecycle operations: ported from the package's own cases. Every name is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelCoordinationSession,
  closeCoordinationSession,
  confirmCoordinationSession,
  createCoordinationSession,
  forkCoordinationSession,
  mergeCoordinationSessions,
  readCoordinationSession,
  recordCoordinationSessionNoShow,
  requestCoordinationSessionFeedback,
  rescheduleCoordinationSession,
  runASessionOperation,
  supersedeCoordinationSession,
  updateCoordinationSession,
} from '../do-work/session-lifecycle.ts';

const state = key => ({ key, descriptor_ref: `lifecycle:${key}` });
const mode = key => ({ key, descriptor_ref: `mode:${key}` });

function buildSession(sessionId, subjectRef) {
  return createCoordinationSession({
    session_id: sessionId,
    purpose_contract: { key: 'generic-purpose', descriptor_ref: 'purpose:generic' },
    candidate_occurrences: [{ occurrence_id: `${sessionId}:occurrence:1`, starts_at: '2026-09-01T15:00:00Z', ends_at: '2026-09-01T16:00:00Z', time_zone: 'UTC', calendar_system: 'gregorian' }],
    candidate_places: [{ choice_descriptor: { key: 'participant-choice', descriptor_ref: 'place:participant' } }],
    candidate_modes: [mode('open-mode')],
    capacity_plan: { capacity_policy_ref: 'capacity-policy:generic', seat_ledger_ref: `ledger:${sessionId}` },
    participation_policy: { visibility_predicate_ref: 'rule:visible', eligibility_predicate_ref: 'rule:eligible' },
    lifecycle_state: state('authored'),
    workflow_definition_ref: 'workflow:generic',
    participant_provenance: [{ provenance_id: `participant:${sessionId}:${subjectRef}`, subject_ref: subjectRef, source_session_id: sessionId, participant_relation_ref: `relation:${sessionId}:${subjectRef}` }],
    preference_provenance: [{ provenance_id: `preference:${sessionId}:${subjectRef}`, subject_ref: subjectRef, source_session_id: sessionId, preference_fact_ref: `fact:${sessionId}:${subjectRef}` }],
  });
}
const single = result => { assert.ok(!('predecessor' in result)); return result; };
const operationOf = session => session.fork_merge_provenance.operation;

test('every named operation runs its own implementation', () => {
  const first = buildSession('session:first', 'subject:one');
  const second = buildSession('session:second', 'subject:two');
  const next = state('next');
  const run = request => runASessionOperation(request);
  assert.equal(operationOf(single(run({ operation: 'create', session: first }))), 'create');
  assert.equal(operationOf(single(run({ operation: 'update', session: first, patch: { purpose_contract: { key: 'updated', descriptor_ref: 'purpose:updated' } } }))), 'update');
  assert.equal(operationOf(single(run({ operation: 'reschedule', session: first, reschedule: { lifecycle_state: next, candidate_occurrences: first.candidate_occurrences } }))), 'reschedule');
  assert.equal(operationOf(single(run({ operation: 'fork', session: first, fork: { session_id: 'session:fork', lifecycle_state: next } }))), 'fork');
  assert.equal(operationOf(single(run({ operation: 'merge', sessions: [first, second], merge: { session_id: 'session:merge', lifecycle_state: next } }))), 'merge');
  assert.equal(operationOf(single(run({ operation: 'cancel', session: first, lifecycle_state: next }))), 'cancel');
  assert.equal(operationOf(single(run({ operation: 'confirm', session: first, lifecycle_state: next }))), 'confirm');
  assert.equal(operationOf(single(run({ operation: 'record_no_show', session: first, lifecycle_state: next }))), 'record_no_show');
  assert.equal(operationOf(single(run({ operation: 'close', session: first, lifecycle_state: next }))), 'close');
  const supersede = run({ operation: 'supersede', session: first, supersede: { session_id: 'session:successor', lifecycle_state: next, predecessor_lifecycle_state: state('superseded') } });
  assert.equal(operationOf(supersede.predecessor), 'supersede');
  assert.equal(supersede.successor.supersedes_ref, first.session_id);
  const feedback = single(run({ operation: 'request_feedback', session: first, lifecycle_state: next, feedback_request_ref: 'request:feedback' }));
  assert.deepEqual([operationOf(feedback), feedback.feedback_request_ref], ['request_feedback', 'request:feedback']);
});

test('malformed and unsupported requests fail closed', () => {
  assert.throws(() => runASessionOperation({}), /operation/i);
  assert.throws(() => runASessionOperation({ operation: 'merge', sessions: [] }), /at least two/i);
  assert.throws(() => runASessionOperation({ operation: 'made_up', session: buildSession('session:invalid', 'subject:invalid') }), /unsupported/i);
});

test('lineage and participant and preference provenance survive reschedule, fork, merge and supersede', () => {
  const first = buildSession('session:alpha', 'subject:one');
  const second = buildSession('session:beta', 'subject:two');
  const rescheduled = rescheduleCoordinationSession(first, {
    lifecycle_state: state('rescheduled'),
    candidate_occurrences: [{ ...first.candidate_occurrences[0], occurrence_id: 'session:alpha:occurrence:2', starts_at: '2026-09-02T15:00:00Z', ends_at: '2026-09-02T16:00:00Z' }],
  });
  const forked = forkCoordinationSession(rescheduled, { session_id: 'session:alpha-fork', lifecycle_state: state('forked') });
  const merged = mergeCoordinationSessions([forked, second], { session_id: 'session:merged', lifecycle_state: state('merged') });
  const { successor } = supersedeCoordinationSession(merged, { session_id: 'session:successor', lifecycle_state: state('successor-authored'), predecessor_lifecycle_state: state('superseded') });
  assert.equal(rescheduled.session_id, first.session_id);
  assert.deepEqual(forked.fork_merge_provenance.lineage_session_ids.sort(), ['session:alpha', 'session:alpha-fork']);
  for (const id of ['session:alpha', 'session:alpha-fork', 'session:beta', 'session:merged']) assert.ok(merged.fork_merge_provenance.lineage_session_ids.includes(id), id);
  for (const id of ['session:alpha', 'session:beta', 'session:merged', 'session:successor']) assert.ok(successor.fork_merge_provenance.lineage_session_ids.includes(id), id);
  assert.deepEqual(successor.participant_provenance.map(item => item.subject_ref).sort(), ['subject:one', 'subject:two']);
  assert.deepEqual(successor.preference_provenance.map(item => item.subject_ref).sort(), ['subject:one', 'subject:two']);
  assert.equal(successor.supersedes_ref, 'session:merged');
});

test('open descriptor data stays valid through every named operation', () => {
  const created = buildSession('session:generic', 'subject:generic');
  const updated = updateCoordinationSession(created, { purpose_contract: { key: 'generic-purpose', descriptor_ref: 'purpose:open', data: { values: ['surviving-generic-value'] } } });
  const rescheduled = rescheduleCoordinationSession(updated, { lifecycle_state: state('rescheduled-open'), candidate_occurrences: updated.candidate_occurrences });
  const forked = forkCoordinationSession(rescheduled, { session_id: 'session:generic-fork', lifecycle_state: state('forked-open') });
  const merged = mergeCoordinationSessions([rescheduled, forked], { session_id: 'session:generic-merged', lifecycle_state: state('merged-open') });
  const superseded = supersedeCoordinationSession(merged, { session_id: 'session:generic-next', lifecycle_state: state('next-open'), predecessor_lifecycle_state: state('superseded-open') });
  const cancelled = cancelCoordinationSession(superseded.successor, state('cancelled-open'));
  const confirmed = confirmCoordinationSession(cancelled, state('confirmed-open'));
  const noShow = recordCoordinationSessionNoShow(confirmed, state('no-show-open'));
  const closed = closeCoordinationSession(noShow, state('closed-open'));
  const feedback = requestCoordinationSessionFeedback(closed, state('feedback-open'), 'request:feedback:generic');
  assert.equal(readCoordinationSession([feedback], feedback.session_id), feedback);
  assert.equal(feedback.feedback_request_ref, 'request:feedback:generic');
  assert.deepEqual(feedback.purpose_contract.data.values, ['surviving-generic-value']);
});

test('a session needs the fields it is checked on, and nothing names another package', () => {
  const base = buildSession('session:one', 'subject:one');
  assert.throws(() => createCoordinationSession({ ...base, session_id: ' ' }), /session_id must be a non-empty string/);
  assert.throws(() => createCoordinationSession({ ...base, workflow_definition_ref: '' }), /workflow_definition_ref/);
  assert.throws(() => createCoordinationSession({ ...base, capacity_plan: { capacity_policy_ref: 'p', seat_ledger_ref: '' } }), /seat_ledger_ref/);
  assert.throws(() => createCoordinationSession({ ...base, purpose_contract: { key: '', descriptor_ref: 'x' } }), /purpose_contract\.key/);
  assert.throws(() => requestCoordinationSessionFeedback(base, state('x'), ' '), /feedback_request_ref/);
  assert.throws(() => mergeCoordinationSessions([base], { session_id: 's', lifecycle_state: state('x') }), /at least two/);
  assert.doesNotMatch(JSON.stringify(base), /package::/);
  assert.equal(base.owner_refs, undefined);
});
