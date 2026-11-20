// test/schedule-graph.test.mjs
// The old projection test (Bitfield packages/timed-action __tests__/scheduled-action-projection.test.mjs at d926b7adb8), run on
// read-data/schedule-graph.mjs with the same fixture (test/scheduled-action-records.json, byte-equal to the old one).
// Tests 1 to 4 are the old assertions; test 5 (the receipt rule) is new and is the old read's receipt branch, lines 33-36 at d926b7adb8.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readScheduledActionGraph } from '../read-data/schedule-graph.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(resolve(here, 'scheduled-action-records.json'), 'utf8'));
const now = '2026-06-22T15:30:00.000Z';

test('the view counts every row it read, and the two records get their due states, blocked count and refs', () => {
  const view = readScheduledActionGraph(fixture, { now });
  assert.equal(view.projection_id, 'default');
  assert.equal(view.items.length, 2);
  assert.equal(view.proof.record_count, 2);
  assert.equal(view.proof.relationship_count, 3);
  assert.equal(view.proof.time_window_count, 2);
  assert.equal(view.proof.action_descriptor_count, 2);
  assert.equal(view.proof.owner_evidence_count, 1);
  assert.equal(view.proof.blocked_action_count, 1);
  assert.equal(view.proof.receipt_count, 1);
  const byId = Object.fromEntries(view.items.map(item => [item.record_id, item]));
  assert.equal(byId['work-a'].due_state, 'due');
  assert.equal(byId['work-a'].blocked_action_count, 1);
  assert.deepEqual(byId['work-a'].next_action_refs, ['repair-1']);
  assert.equal(byId['work-b'].due_state, 'scheduled');
  assert.deepEqual(view.groups.Queue.sort(), ['work-a', 'work-b']);
});

test('a record added with its own window and group is read with its label and group', () => {
  const invented = structuredClone(fixture);
  invented.records.push({ role: 'record', record_id: 'work-c', fields: { title: 'Inventory restock', group: 'Warehouse' } });
  invented.time_windows.push({ time_window_id: 'tw-c', record_id: 'work-c', start: '2026-06-22T13:00:00.000Z' });
  invented.actions.push({ action_id: 'action-c', record_id: 'work-c', dispatch: { name: 'slot::workflow', input: { operation: 'execute_definition', definition_id: 'action:new-owner.whatever', input: {} } } });
  const view = readScheduledActionGraph(invented, { now });
  assert.equal(view.items.find(item => item.record_id === 'work-c').label, 'Inventory restock');
  assert.deepEqual(view.groups.Warehouse, ['work-c']);
});

test('a record with no group field is grouped under Other and never dropped; no Ungrouped group appears', () => {
  const fallback = structuredClone(fixture);
  fallback.records.push({ role: 'record', record_id: 'morning-run-2026-08-22', fields: {} });
  fallback.time_windows.push({ time_window_id: 'tw-fallback', record_id: 'morning-run-2026-08-22', start: '2026-06-22T13:00:00.000Z' });
  fallback.actions.push({ action_id: 'action-fallback', record_id: 'morning-run-2026-08-22', dispatch: { name: 'slot::workflow', input: { operation: 'execute_definition', definition_id: 'action:timed-action.run-recurring-owner-v1', input: {} } } });
  const view = readScheduledActionGraph(fallback, { now });
  assert.equal(view.items.find(item => item.record_id === 'morning-run-2026-08-22').label, '');
  assert.deepEqual(view.groups.Other, ['morning-run-2026-08-22']);
  assert.equal(Object.keys(view.groups).includes('Ungrouped'), false);
});

test('an empty input reads as an empty view with zero counts', () => {
  const empty = readScheduledActionGraph({}, { now });
  assert.equal(empty.items.length, 0);
  assert.equal(empty.proof.record_count, 0);
});

test('a latest receipt of canceled or completed wins over the window\'s due state', () => {
  const receipted = structuredClone(fixture);
  receipted.receipts = [{ record_id: 'work-a', operation: 'completed', observed_at: '2026-06-22T15:00:00.000Z' }];
  const view = readScheduledActionGraph(receipted, { now });
  assert.equal(view.items.find(item => item.record_id === 'work-a').due_state, 'completed');
  assert.equal(view.proof.receipt_count, 1);
});
