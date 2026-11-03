import test from 'node:test';
import assert from 'node:assert/strict';
import { timeboxEvent, timeboxPolicies } from '../do-work/timebox-policy.mjs';

const task = { id: 't', title: 'Write report', duration_minutes: 60, due: '2026-10-16T17:00:00Z', deadline_type: 'hard' };
const proposal = { starts_at: '2026-10-15T09:00:00.000Z', ends_at: '2026-10-15T10:00:00.000Z' };

test('nothing is written unless a writing row was chosen, and an unknown row writes nothing', () => {
  assert.equal(timeboxEvent('off', task, proposal), null);
  assert.equal(timeboxEvent(undefined, task, proposal), null, 'the default is off');
  assert.equal(timeboxEvent('made-up', task, proposal), null);
  assert.deepEqual(timeboxPolicies.map(row => [row.id, row.writes]), [['off', false], ['free', true], ['busy', true], ['busy_when_at_risk', true]]);
});

test('the event is the previewed slot, free, and busy only for a task at risk', () => {
  assert.deepEqual(timeboxEvent('free', task, proposal), { title: 'Write report', start: proposal.starts_at, end: proposal.ends_at, transparency: 'transparent', visibility: 'default' });
  assert.equal(timeboxEvent('busy_when_at_risk', task, proposal).transparency, 'opaque', 'a hard deadline within 48 hours of the end');
  assert.equal(timeboxEvent('busy_when_at_risk', { ...task, due: '2026-11-30T00:00:00Z' }, proposal).transparency, 'transparent');
  assert.equal(timeboxEvent('busy_when_at_risk', { ...task, deadline_type: 'none' }, proposal).transparency, 'transparent', 'a deadline that does not bind is not a risk');
  assert.equal(timeboxEvent('busy_when_at_risk', { ...task, due: '2026-11-30T00:00:00Z' }, { ...proposal, late: true }).transparency, 'opaque', 'placed after its deadline');
});

test('busy is always busy, a high or super priority makes the middle row busy, and privacy maps to event visibility', () => {
  const far = { ...task, due: '2026-11-30T00:00:00Z' };
  assert.equal(timeboxEvent('busy', far, proposal).transparency, 'opaque');
  assert.equal(timeboxEvent('busy_when_at_risk', { ...far, priority: 'high' }, proposal).transparency, 'opaque');
  assert.equal(timeboxEvent('busy_when_at_risk', { ...far, priority: 'urgent' }, proposal).transparency, 'opaque');
  assert.equal(timeboxEvent('busy_when_at_risk', { ...far, priority: 'low' }, proposal).transparency, 'transparent');
  assert.equal(timeboxEvent('free', task, proposal, 'private').visibility, 'private');
  assert.equal(timeboxEvent('free', task, proposal, 'visible').visibility, 'default');
  assert.equal(timeboxEvent('free', task, proposal, 'nonsense').visibility, 'default');
});
