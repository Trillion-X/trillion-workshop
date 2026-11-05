// parts/timed-action/do-work/when-to-wake.ts as a Durable Object alarm uses it: each wake asks what is due and when to
// wake next, runs what is due, records the owner's proof, and sets the alarm again. Times cross a daylight-saving
// change in New York.
import test from 'node:test';
import assert from 'node:assert/strict';
import { whenToWake } from '../do-work/when-to-wake.ts';

const mondayReview = {
  schedule_id: 'schedule:monday-review',
  source_generation: 1,
  schedule_revision: 1,
  timezone: 'America/New_York',
  start_local_date: '2026-03-02',
  cadence: { unit: 'week', weekdays: [1] },
  local_window: { start: '09:00', duration_minutes: 30 },
  action: {
    operation: 'write-weekly-review',
    owner_ref: 'tool:write-review',
    owner_dispatch: { name: 'tool:write-review', input: {} },
    completion: { mode: 'synchronous-owner-return' },
  },
};

const proven = (occurrence_key, at) => ({
  occurrence_key, materialization_key: occurrence_key, materialized_at: at,
  owner_outcome: { proven: true, owner_ref: 'tool:write-review', proof_ref: `run:${at}`, observed_at: at },
});

test('an alarm loop runs a weekly schedule at 09:00 New York time on both sides of the clock change', () => {
  // A stand-in for the Durable Object: its alarm and the occurrence state it keeps.
  const alarm = { at: null };
  const states = [];
  const ran = [];
  const wake = now => {
    const answer = whenToWake({ now, schedules: [mondayReview], occurrence_states: states });
    for (const occurrence of answer.recurring_due) {
      ran.push(occurrence.start);
      states.push(proven(occurrence.occurrence_key, occurrence.start));
    }
    alarm.at = answer.next_wake_at;
    return answer;
  };

  const first = wake('2026-03-01T12:00:00Z');
  assert.deepEqual(first.recurring_due, []);
  assert.equal(alarm.at, '2026-03-02T14:00:00.000Z', '09:00 EST is 14:00 UTC');
  wake(alarm.at);
  assert.equal(alarm.at, '2026-03-09T13:00:00.000Z', 'after the change on 8 March, 09:00 EDT is 13:00 UTC');
  wake(alarm.at);
  assert.deepEqual(ran, ['2026-03-02T14:00:00.000Z', '2026-03-09T13:00:00.000Z']);
  assert.equal(alarm.at, '2026-03-16T13:00:00.000Z');
});

test('an occurrence whose owner did not prove its outcome stays due, and its materialization is offered once', () => {
  const answer = whenToWake({ now: '2026-03-02T14:05:00Z', schedules: [mondayReview] });
  assert.equal(answer.recurring_due.length, 1);
  assert.equal(answer.materializations.length, 1);
  const key = answer.recurring_due[0].occurrence_key;
  // Recorded but not proven: still due, now a retry of the same occurrence, nothing new to record.
  const retry = whenToWake({ now: '2026-03-02T15:00:00Z', schedules: [mondayReview], occurrence_states: [{ occurrence_key: key, materialization_key: key, materialized_at: '2026-03-02T14:05:00Z' }] });
  assert.equal(retry.recurring_due[0].occurrence_key, key);
  assert.equal(retry.recurring_due[0].retry_same_occurrence, true);
  assert.deepEqual(retry.materializations, []);
});

test('the runtime wake reducer keeps its single-next-occurrence contract', () => {
  const answer = whenToWake({ now: '2026-03-01T12:00:00Z', schedules: [mondayReview] });
  assert.equal(answer.next_wake_at, '2026-03-02T14:00:00.000Z');
  assert.deepEqual(answer.recurring_due, []);
  assert.equal(Object.hasOwn(answer, 'future_occurrences'), false);
});

test('a time that does not exist on the change night is skipped or moved to the next valid minute, as the schedule says', () => {
  const nightly = { ...mondayReview, schedule_id: 'schedule:nightly', start_local_date: '2026-03-08', cadence: { unit: 'day' }, local_window: { start: '02:30', duration_minutes: 10 } };
  const skipped = whenToWake({ now: '2026-03-08T05:00:00Z', schedules: [nightly] });
  assert.equal(skipped.skipped_resolutions[0].reason, 'dst_gap_skip');
  assert.equal(skipped.next_wake_at, '2026-03-09T06:30:00.000Z', 'the next night, 02:30 EDT');
  const moved = whenToWake({ now: '2026-03-08T05:00:00Z', schedules: [{ ...nightly, dst: { gap: 'next-valid' } }] });
  assert.equal(moved.next_wake_at, '2026-03-08T07:00:00.000Z', '03:00 EDT, the first minute that exists');
});

test('one-off actions: due once their window opens, gone once a receipt names them, and the earliest one ahead sets the alarm', () => {
  const dispatch = { name: 'tool:send-message', input: { to: 'me' } };
  const graph = {
    time_windows: [
      { record_id: 'remind-a', time_window_id: 'w-a', start: '2026-03-10T09:00:00Z' },
      { record_id: 'remind-b', time_window_id: 'w-b', start: '2026-03-12T09:00:00Z' },
      { record_id: 'remind-c', time_window_id: 'w-c', start: '2026-03-11T09:00:00Z' },
    ],
    actions: [
      { record_id: 'remind-a', action_id: 'send', dispatch },
      { record_id: 'remind-b', action_id: 'send', dispatch },
      { record_id: 'remind-c', action_id: 'send' },
    ],
  };
  const before = whenToWake({ now: '2026-03-09T00:00:00Z', ...graph });
  assert.deepEqual(before.scheduled_due, []);
  assert.equal(before.next_wake_at, '2026-03-10T09:00:00.000Z', 'an action without its own dispatch never sets the alarm');
  const at = whenToWake({ now: before.next_wake_at, ...graph });
  assert.deepEqual(at.scheduled_due.map(fire => fire.record_id), ['remind-a']);
  assert.equal(at.next_wake_at, '2026-03-12T09:00:00.000Z');
  const done = whenToWake({ now: '2026-03-10T10:00:00Z', ...graph, receipts: [{ record_id: 'remind-a', operation: 'send' }] });
  assert.deepEqual(done.scheduled_due, []);
  assert.throws(() => whenToWake({ now: 'soon' }), /not a time/);
});
