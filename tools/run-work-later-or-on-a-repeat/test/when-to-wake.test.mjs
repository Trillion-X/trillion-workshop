// The timed-action engine's whenToWake (do-work/timed-action.mjs) as an alarm uses it: each wake asks what is due and when to
// wake next, runs what is due, records the owner's proof, and sets the alarm again. Times cross a daylight-saving
// change in New York.
import test from 'node:test';
import assert from 'node:assert/strict';
import { whenToWake } from '../do-work/timed-action.mjs';

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

test('resume_from_ms: a schedule first seen now starts from now, and a caller keeping only states from its last proof stays bounded', () => {
  const daily = { ...mondayReview, schedule_id: 'schedule:daily', start_local_date: '2020-01-01', cadence: { unit: 'day' } };
  const from = Date.parse('2026-03-05T12:00:00Z');
  const first = whenToWake({ now: from, schedules: [daily], resume_from_ms: from });
  assert.deepEqual(first.recurring_due, [], 'six years of past days are not caught up');
  assert.equal(first.next_wake_at, '2026-03-05T14:00:00.000Z', 'its first time from now: 09:00 New York that day');
  // Each day: run what is due, keep only that proof, and move resume_from_ms to its start.
  let resume = from;
  let states = [];
  const ran = [];
  for (const now of ['2026-03-05T14:00:00Z', '2026-03-06T14:00:00Z', '2026-03-07T14:00:00Z', '2026-03-08T13:00:00Z']) {
    const answer = whenToWake({ now, schedules: [daily], occurrence_states: states, resume_from_ms: resume });
    for (const occurrence of answer.recurring_due) {
      ran.push(occurrence.start);
      states = [proven(occurrence.occurrence_key, occurrence.start)];
      resume = Date.parse(occurrence.start);
    }
  }
  assert.deepEqual(ran, ['2026-03-05T14:00:00.000Z', '2026-03-06T14:00:00.000Z', '2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z'],
    '09:00 New York on both sides of the clock change, one state kept');
  // Asleep for four days: the latest day runs once, and says it passed over the three before it.
  const late = whenToWake({ now: '2026-03-12T15:00:00Z', schedules: [daily], occurrence_states: states, resume_from_ms: resume });
  assert.deepEqual(late.recurring_due.map(occurrence => [occurrence.start, occurrence.missed_before]), [['2026-03-12T13:00:00.000Z', 3]]);
});

test('any cadence asleep for a year runs once on waking and says how many times it missed; on time it missed none', () => {
  const zone = { source_generation: 1, schedule_revision: 1, timezone: 'UTC', start_local_date: '2025-01-01', action: mondayReview.action };
  const cases = [
    [{ ...zone, schedule_id: 'schedule:every-6h', cadence: { unit: 'hour', interval: 6 }, local_window: { start: '00:00', duration_minutes: 5 } }, ['2026-01-01T12:00:00.000Z', 1462]],
    [{ ...zone, schedule_id: 'schedule:daily', cadence: { unit: 'day' }, local_window: { start: '09:00', duration_minutes: 5 } }, ['2026-01-01T09:00:00.000Z', 365]],
    [{ ...zone, schedule_id: 'schedule:mondays', cadence: { unit: 'week', weekdays: [1] }, local_window: { start: '09:00', duration_minutes: 5 } }, ['2025-12-29T09:00:00.000Z', 51]],
  ];
  const slept = Date.parse('2025-01-01T00:00:00Z');
  for (const [schedule, expected] of cases) {
    const woke = whenToWake({ now: '2026-01-01T13:00:00Z', schedules: [schedule], resume_from_ms: slept });
    assert.deepEqual(woke.recurring_due.map(occurrence => [occurrence.start, occurrence.missed_before]), [expected], schedule.schedule_id);
    // Once that time is proven, the next time asked for on time is due alone, having missed none.
    const [ran] = woke.recurring_due;
    const kept = { schedules: [schedule], occurrence_states: [proven(ran.occurrence_key, ran.start)], resume_from_ms: Date.parse(ran.start) };
    const next = whenToWake({ now: '2026-01-01T13:00:00Z', ...kept }).next_wake_at;
    const onTime = whenToWake({ now: Date.parse(next) + 60_000, ...kept });
    assert.deepEqual(onTime.recurring_due.map(occurrence => [occurrence.start, occurrence.missed_before]), [[next, 0]], `${schedule.schedule_id} on time misses none`);
  }
});

test('asked with no resume point, a schedule begun decades ago is due at its latest time, not where the scan bound ends', () => {
  const daily = { source_generation: 1, schedule_revision: 1, timezone: 'UTC', start_local_date: '1970-01-01', action: mondayReview.action,
    schedule_id: 'schedule:since-1970', cadence: { unit: 'day' }, local_window: { start: '14:00', duration_minutes: 1 } };
  const asked = whenToWake({ now: '2026-11-18T11:00:00Z', schedules: [daily] });
  const [due] = asked.recurring_due;
  assert.equal(asked.recurring_due.length, 1);
  assert.equal(due.start, '2026-11-17T14:00:00.000Z', 'the latest time that has come');
  assert.ok(due.missed_before > 4000 && Date.parse(due.missed_since) < Date.parse(due.start), `${due.missed_before} since ${due.missed_since}`);
  assert.equal(asked.next_wake_at ?? null, null);
});

test('a schedule names its action and its owner, and nothing about how the owner answers', () => {
  const { completion, ...action } = { ...mondayReview.action, completion: { mode: 'synchronous-owner-return' } };
  const bare = { ...mondayReview, schedule_id: 'schedule:no-completion', action };
  const answer = whenToWake({ now: '2026-03-01T12:00:00Z', schedules: [bare], resume_from_ms: Date.parse('2026-03-01T12:00:00Z') });
  assert.deepEqual(answer.rejected_schedules, [], 'a schedule with no completion is taken');
  assert.equal(answer.next_wake_at, '2026-03-02T14:00:00.000Z');
  const kept = whenToWake({ now: '2026-03-01T12:00:00Z', schedules: [{ ...bare, action: { ...action, completion } }], resume_from_ms: Date.parse('2026-03-01T12:00:00Z') });
  assert.equal(kept.next_wake_at, answer.next_wake_at, 'one that still carries it is the same');
});
