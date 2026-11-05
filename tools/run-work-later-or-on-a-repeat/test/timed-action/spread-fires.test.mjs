import test from 'node:test';
import assert from 'node:assert/strict';
import { whenToWake } from '../../do-work/when-to-wake.ts';
import { fractionOf, spreadOneShotDue, spreadRecurringStart } from '../../do-work/spread-fires.ts';
import settings from '../../../keep-and-wake-ai-sessions-on-this-computer/src/scheduler.json' with { type: 'json' };

const every = (id) => ({
  schedule_id: id, source_generation: 1, schedule_revision: 1, timezone: 'UTC', start_local_date: '2026-03-02',
  cadence: { unit: 'hour', interval: 1 }, local_window: { start: '00:00', duration_minutes: 5 },
  action: { operation: 'tick', owner_ref: 'tool:t', owner_dispatch: { name: 'tool:t', input: {} }, completion: { mode: 'synchronous-owner-return' } },
});
const spread = settings.spread;
const at = Date.parse('2026-03-02T10:00:00Z');

test('the same id has the same offset every wake; recurring only slips later, within the cap', () => {
  assert.equal(fractionOf('schedule:a'), fractionOf('schedule:a'));
  const slipped = spreadRecurringStart(at, 'schedule:a', 3_600_000, spread);
  assert.ok(slipped >= at && slipped - at <= Math.min(0.1 * 3_600_000, 900_000));
  assert.equal(spreadRecurringStart(at, 'schedule:a', 3_600_000, null), at);
});
test('a one-off on a round minute moves only earlier and never before its creation', () => {
  const due = Date.parse('2026-03-02T15:00:00Z');
  const early = spreadOneShotDue(due, 'rec:1', null, spread);
  assert.ok(early <= due && due - early <= 90_000);
  assert.equal(spreadOneShotDue(due + 60_000, 'rec:1', null, spread), due + 60_000);
  assert.equal(spreadOneShotDue(due, 'rec:1', due - 1000, spread), due);
});
test('whenToWake with spread: the recurring fire is not due at :00 but at its offset; without spread it is', () => {
  const schedule = every('schedule:a');
  const plain = whenToWake({ now: at, schedules: [schedule] });
  assert.equal(plain.recurring_due.length, 1);
  const offset = spreadRecurringStart(at, 'schedule:a', 3_600_000, spread);
  const held = whenToWake({ now: at, schedules: [schedule], spread });
  assert.equal(held.recurring_due.length, offset > at ? 0 : 1);
  assert.equal(Date.parse(held.next_wake_at), offset > at ? offset : Date.parse(held.next_wake_at));
  const later = whenToWake({ now: offset, schedules: [schedule], spread });
  assert.equal(later.recurring_due.length, 1);
  console.log('READBACK', JSON.stringify({ at: new Date(at).toISOString(), plain_due: plain.recurring_due.length, spread_due_at_00: held.recurring_due.length, offset_seconds: (offset - at) / 1000, next_wake_at: held.next_wake_at }));
});
test('one-off action due at 15:00 fires up to 90s earlier under spread, never when spread is off', () => {
  const due = '2026-03-02T15:00:00.000Z';
  const input = { time_windows: [{ record_id: 'r1', start: due }], actions: [{ record_id: 'r1', dispatch: { name: 'tool:x', input: {} } }] };
  const early = Date.parse(due) - Math.floor((fractionOf('r1') * 90) * 1000);
  assert.equal(whenToWake({ now: Date.parse(due) - 100_000, ...input, spread }).scheduled_due.length, 0);
  assert.equal(whenToWake({ now: early, ...input, spread }).scheduled_due.length, 1);
  assert.equal(whenToWake({ now: early, ...input }).scheduled_due.length, early >= Date.parse(due) ? 1 : 0);
});
