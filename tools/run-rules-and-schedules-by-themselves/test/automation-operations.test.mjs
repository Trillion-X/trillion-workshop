// tools/run-rules-and-schedules-by-themselves/test/automation-operations.test.mjs
// Old assertions this keeps (src/automations.mjs, old Worker b6ae0ebf815f): checkedEvery refuses a step under 5 minutes
// and a bad time or zone; a schedule is repeat or one time; setRule keeps only one of recorded/space/source; the stale
// edit is refused; a per-item enabled change keeps everything else; run now lays its input over the then's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAutomationOperation, AutomationError } from '../src/automation-operations.mjs';

const NOW = '2026-11-20T09:00:00.000Z';
const daily = { schedule_id: 's1', label: 'Morning review', every: { unit: 'day', at: '09:00', time_zone: 'America/New_York' }, then: { tool_id: 'tool:x', input: { a: 1 } } };
const reason = expected => error => error instanceof AutomationError && error.reason === expected;

test('list answers the kept schedules under schedules', () => {
  const { answer, items } = runAutomationOperation({ kind: 'schedule', operation: 'list', items: [{ schedule_id: 's0' }] });
  assert.deepEqual(answer.schedules, [{ schedule_id: 's0' }]);
  assert.equal(items.length, 1);
});

test('set keeps a repeating schedule with its time zone and set_at, enabled by default', () => {
  const { items, answer } = runAutomationOperation({ kind: 'schedule', operation: 'set', input: daily, items: [], now: NOW });
  assert.equal(items.length, 1);
  assert.equal(answer.saved.enabled, true);
  assert.equal(answer.saved.set_at, NOW);
  assert.deepEqual(answer.saved.every, { unit: 'day', at: '09:00', time_zone: 'America/New_York', interval: 1 });
});

test('set accepts a one-time schedule with a zone and refuses one without an offset', () => {
  const ok = runAutomationOperation({ kind: 'schedule', operation: 'set', input: { schedule_id: 'once', once_at: '2026-12-01T09:00:00-05:00', then: { workflow_id: 'workflow:w' } }, items: [], now: NOW });
  assert.equal(ok.answer.saved.once_at, '2026-12-01T09:00:00-05:00');
  assert.throws(() => runAutomationOperation({ kind: 'schedule', operation: 'set', input: { schedule_id: 'bad', once_at: '2026-12-01T09:00:00', then: { tool_id: 't' } }, items: [], now: NOW }), reason('once_at'));
});

test('set refuses a step under five minutes, a bad time, an unknown zone, and a schedule with both or neither timing', () => {
  const base = { schedule_id: 'x', then: { tool_id: 't' } };
  assert.throws(() => runAutomationOperation({ kind: 'schedule', operation: 'set', input: { ...base, every: { unit: 'minute', interval: 4, time_zone: 'UTC' } }, items: [], now: NOW }), reason('every'));
  assert.throws(() => runAutomationOperation({ kind: 'schedule', operation: 'set', input: { ...base, every: { unit: 'day', at: '9am', time_zone: 'UTC' } }, items: [], now: NOW }), reason('every'));
  assert.throws(() => runAutomationOperation({ kind: 'schedule', operation: 'set', input: { ...base, every: { unit: 'day', at: '09:00', time_zone: 'Mars/Olympus' } }, items: [], now: NOW }), reason('every'));
  assert.throws(() => runAutomationOperation({ kind: 'schedule', operation: 'set', input: base, items: [], now: NOW }), reason('every'));
});

test('a per-schedule off keeps everything else; run now still runs it', () => {
  const { items } = runAutomationOperation({ kind: 'schedule', operation: 'set', input: daily, items: [], now: NOW });
  const off = runAutomationOperation({ kind: 'schedule', operation: 'set', input: { schedule_id: 's1', enabled: false }, items, now: '2026-11-20T10:00:00.000Z' });
  assert.equal(off.items[0].enabled, false);
  assert.deepEqual(off.items[0].every, { ...daily.every, interval: 1 });
  assert.equal(off.items[0].set_at, '2026-11-20T10:00:00.000Z');
  const ran = runAutomationOperation({ kind: 'schedule', operation: 'run-now', input: { schedule_id: 's1', input: { b: 2 } }, items: off.items });
  assert.deepEqual(ran.answer.dispatch, { tool_id: 'tool:x', input: { a: 1, b: 2 } });
});

test('a rule keeps one of recorded, space or source, with where tests', () => {
  const rule = { rule_id: 'r1', label: 'File invoices', when: { recorded: 'message', where: [{ field: 'text', contains: 'invoice' }] }, then: { workflow_id: 'workflow:file' } };
  const { answer } = runAutomationOperation({ kind: 'rule', operation: 'set', input: rule, items: [], now: NOW });
  assert.deepEqual(answer.saved.when, { recorded: 'message', where: [{ field: 'text', contains: 'invoice' }] });
  assert.throws(() => runAutomationOperation({ kind: 'rule', operation: 'set', input: { rule_id: 'r2', when: { recorded: 'message', space_id: 'p' }, then: { tool_id: 't' } }, items: [], now: NOW }), reason('when'));
  assert.throws(() => runAutomationOperation({ kind: 'rule', operation: 'set', input: { rule_id: 'r3', when: { recorded: 'message', where: [{ field: 'text', contains: 'a', equals: 'b' }] }, then: { tool_id: 't' } }, items: [], now: NOW }), reason('when'));
});

test('a per-rule off keeps the rule and its then; run now runs it while off', () => {
  const { items } = runAutomationOperation({ kind: 'rule', operation: 'set', input: { rule_id: 'r1', when: { source_id: 'events:x', event: 'comment', words: ['guide'] }, then: { tool_id: 't', input: {} } }, items: [], now: NOW });
  const off = runAutomationOperation({ kind: 'rule', operation: 'set', input: { rule_id: 'r1', enabled: false }, items, now: NOW });
  assert.equal(off.items[0].enabled, false);
  assert.deepEqual(off.items[0].when, { source_id: 'events:x', event: 'comment', words: ['guide'] });
  const ran = runAutomationOperation({ kind: 'rule', operation: 'run-now', input: { rule_id: 'r1' }, items: off.items });
  assert.deepEqual(ran.answer.dispatch, { tool_id: 't', input: {} });
});

test('remove takes the item out by id and refuses a stale edit', () => {
  const { items } = runAutomationOperation({ kind: 'schedule', operation: 'set', input: daily, items: [], now: NOW });
  const stale = () => runAutomationOperation({ kind: 'schedule', operation: 'remove', input: { schedule_id: 's1', expected_set_at: '2026-01-01T00:00:00.000Z' }, items });
  assert.throws(stale, reason('set_again'));
  const removed = runAutomationOperation({ kind: 'schedule', operation: 'remove', input: { schedule_id: 's1', expected_set_at: NOW }, items });
  assert.deepEqual(removed.items, []);
  assert.equal(removed.answer.removed.schedule_id, 's1');
  assert.throws(() => runAutomationOperation({ kind: 'schedule', operation: 'remove', input: { schedule_id: 'gone' }, items }), reason('not_found'));
});

test('an unknown operation or kind is refused by name', () => {
  assert.throws(() => runAutomationOperation({ kind: 'rule', operation: 'explode', items: [] }), reason('operation'));
  assert.throws(() => runAutomationOperation({ kind: 'job', operation: 'list', items: [] }), reason('kind'));
});
