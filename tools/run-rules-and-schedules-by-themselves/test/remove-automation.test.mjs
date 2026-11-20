// tools/run-rules-and-schedules-by-themselves/test/remove-automation.test.mjs
// Old assertions this keeps: removeRule and removeSchedule remove by id and refuse a stale edit (automations-stale-edit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeAutomation, AutomationRemoveError } from '../src/remove-automation.mjs';

const rules = () => [
  { rule_id: 'r1', set_at: '2026-11-01T10:00:00Z', label: 'first' },
  { rule_id: 'r2', set_at: '2026-11-02T10:00:00Z', label: 'second' },
];

test('removes the item with that id and keeps the others in order', () => {
  const before = rules();
  const { items, removed } = removeAutomation({ items: before, idField: 'rule_id', id: 'r1' });
  assert.equal(removed.rule_id, 'r1');
  assert.deepEqual(items.map(item => item.rule_id), ['r2']);
  assert.equal(before.length, 2, 'the input list is not changed');
});

test('refuses an id that is not on the list', () => {
  assert.throws(() => removeAutomation({ items: rules(), idField: 'rule_id', id: 'nope' }),
    error => error instanceof AutomationRemoveError && error.reason === 'not_found');
});

test('refuses a stale edit when expected_set_at differs, and removes nothing', () => {
  assert.throws(() => removeAutomation({ items: rules(), idField: 'rule_id', id: 'r1', expected_set_at: '2026-10-01T00:00:00Z' }),
    error => error instanceof AutomationRemoveError && error.reason === 'set_again');
});

test('removes when expected_set_at matches the set_at that was read', () => {
  const { items } = removeAutomation({ items: rules(), idField: 'rule_id', id: 'r1', expected_set_at: '2026-11-01T10:00:00Z' });
  assert.deepEqual(items.map(item => item.rule_id), ['r2']);
});

test('one function removes a schedule by schedule_id the same way', () => {
  const schedules = [{ schedule_id: 's1', set_at: 'a' }, { schedule_id: 's2', set_at: 'b' }];
  const { items, removed } = removeAutomation({ items: schedules, idField: 'schedule_id', id: 's2' });
  assert.equal(removed.schedule_id, 's2');
  assert.deepEqual(items.map(item => item.schedule_id), ['s1']);
});
