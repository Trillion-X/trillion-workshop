// The queue reader, ported from the old changelog-publisher package's read-data, projection and descriptor tests.
// The old tests read the package's own descriptor file; these use a made-up bakery queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readRecordActionProjection } from '../read-data/read-record-action-projection.ts';

const runCommand = input => new Promise(resolve => {
  const child = execFile("node", [command], (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  child.stdin.end(JSON.stringify(input));
});
const command = new URL('../do-work/see-what-is-ready.mjs', import.meta.url).pathname;

const graph = {
  kind: 'generic.record-action-projection-graph',
  surface_copy: { empty_title: 'Nothing is ready.', empty_hint: 'Finished work with proof shows here.' },
  fields: [
    { id: 'field:title', kind: 'generic.field-descriptor', label: 'Headline', order: 10 },
    { id: 'field:summary', kind: 'generic.field-descriptor', label: 'What changed', order: 20 },
  ],
  relationships: [{ id: 'relationship:proof', kind: 'generic.relationship-descriptor', label: 'Proof', order: 10 }],
  views: [
    { id: 'view:queue', kind: 'generic.view-descriptor', label: 'Ready', selected: true, density_threshold: 12, order: 10 },
    { id: 'view:history', kind: 'generic.view-descriptor', label: 'Sent', order: 20 },
  ],
  groups: [
    { id: 'group:ready', kind: 'generic.group-descriptor', label: 'Ready', empty_copy: 'Nothing ready.', order: 10 },
    { id: 'group:sent', kind: 'generic.group-descriptor', label: 'Sent', order: 30 },
  ],
  rules: [{
    id: 'rule:requires-proof', kind: 'generic.rule-descriptor', label: 'Proof', message: 'Add proof before publishing.',
    requires_relationship: 'relationship:proof', blocks_actions: ['action:publish'], order: 10,
  }],
  actions: [
    { id: 'action:save', kind: 'generic.action-descriptor', label: 'Save', method: 'update-field', order: 10 },
    { id: 'action:publish', kind: 'generic.action-descriptor', label: 'Publish', method: 'invoke', target: 'owner:any', order: 30 },
  ],
  projections: [{ id: 'projection:queue', kind: 'generic.projection-descriptor', consumer_modes: ['page', 'phone'] }],
  receipts: [{ id: 'receipt:1', kind: 'generic.receipt-record', record_id: 'record:1', label: 'Sent' }],
};

const ready = (index, extra = {}) => ({ id: `record:${index}`, title: `Bakery news ${index}`, group_id: 'group:ready', ...extra });

test('a queue with no records is empty, and says so in its own words', () => {
  const model = readRecordActionProjection({ graph });
  assert.equal(model.status, 'empty');
  assert.equal(model.copy.empty_title, 'Nothing is ready.');
  assert.deepEqual(model.groups[0].records, []);
  assert.equal(model.selectedRecord, null);
  assert.equal(model.diagnostics.stateSource, 'record-count');
});

test('a record with proof shows its actions, no blocker and its receipts', () => {
  const model = readRecordActionProjection({
    graph,
    selectedRecordId: 'record:1',
    recordAtoms: [ready(1, { relationships: { proof: ['proof:1'] }, action_ids: ['action:publish'], receipt_ids: ['receipt:1'] })],
  });
  assert.equal(model.status, 'sparse');
  assert.equal(model.groups[0].records[0].title, 'Bakery news 1');
  assert.deepEqual(model.selectedRecord.actions.map(action => action.id), ['action:publish']);
  assert.equal(model.selectedRecord.blockers.length, 0);
  assert.deepEqual(model.selectedRecord.receipts.map(receipt => receipt.id), ['receipt:1']);
});

test('a record without proof names the rule that blocks it', () => {
  const model = readRecordActionProjection({ graph, recordAtoms: [ready(1)] });
  assert.deepEqual(model.selectedRecord.blockers.map(rule => rule.id), ['rule:requires-proof']);
  assert.equal(model.selectedRecord.blockers[0].message, 'Add proof before publishing.');
  assert.deepEqual(model.selectedRecord.actions.map(action => action.id), ['action:save', 'action:publish']);
});

test('fields, actions and receipt shapes it has not seen stay as they came', () => {
  const model = readRecordActionProjection({
    graph,
    recordAtoms: [ready('x', { fields: { later_field: { any: ['shape'] } }, action_ids: ['action:not-yet-seen'] })],
    receiptAtoms: [{ id: 'receipt:x', kind: 'generic.receipt-record', record_id: 'record:x', target: 'owner:later' }],
  });
  assert.deepEqual(model.selectedRecord.fields.later_field, { any: ['shape'] });
  assert.ok(model.diagnostics.missingDescriptorIds.includes('action:not-yet-seen'));
  assert.equal(model.selectedRecord.receipts[0].target, 'owner:later');
});

test('empty, sparse, dense, loading, error and blocked come from the data, not from code', () => {
  const twelve = Array.from({ length: 12 }, (_, index) => ready(index));
  assert.equal(readRecordActionProjection({ graph, recordAtoms: twelve }).status, 'dense');
  assert.equal(readRecordActionProjection({ graph, recordAtoms: twelve.slice(0, 11) }).status, 'sparse');
  assert.equal(readRecordActionProjection({ graph, status: 'loading' }).status, 'loading');
  assert.equal(readRecordActionProjection({ graph, issues: ['stale basis'] }).status, 'error');
  assert.equal(readRecordActionProjection({ graph, recordAtoms: [ready(1, { issue: 'no owner' })] }).status, 'blocked');
  const lowThreshold = { ...graph, views: [{ ...graph.views[0], density_threshold: 3 }] };
  assert.equal(readRecordActionProjection({ graph: lowThreshold, recordAtoms: twelve.slice(0, 3) }).status, 'dense');
});

test('a record in a group the queue does not declare lands in an unresolved group', () => {
  const model = readRecordActionProjection({ graph, recordAtoms: [ready(1, { group_id: 'group:later' })] });
  const unresolved = model.groups.at(-1);
  assert.equal(unresolved.id, 'group:unresolved');
  assert.equal(unresolved.records.length, 1);
  assert.ok(model.diagnostics.missingDescriptorIds.includes('group:later'));
});

test('two receipts on one record are both listed, and a different product is only different data', () => {
  const model = readRecordActionProjection({
    graph: { ...graph, groups: [{ id: 'group:any', kind: 'generic.group-descriptor', label: 'Any work', order: 1 }] },
    recordAtoms: [
      { id: 'row:1', title: 'Order row', group_id: 'group:any', receipt_ids: ['receipt:a', 'receipt:b'] },
      { id: 'row:2', title: 'Booking row', group_id: 'group:any' },
    ],
    receiptAtoms: [
      { id: 'receipt:a', kind: 'generic.receipt-record', record_id: 'row:1', label: 'First' },
      { id: 'receipt:b', kind: 'generic.receipt-record', record_id: 'row:1', label: 'Second' },
    ],
  });
  assert.deepEqual(model.groups[0].records.map(record => record.title), ['Order row', 'Booking row']);
  assert.equal(model.selectedRecord.receipts.length, 2);
  assert.equal(model.diagnostics.descriptorCounts.records, 2);
});

test("the command prints the queue on its last line and refuses a request with no graph", async () => {
  const ok = await runCommand({ graph, recordAtoms: [ready(1)] });
  assert.equal(JSON.parse(ok.stdout.trim().split("\n").at(-1)).groups[0].records[0].id, "record:1");
  const refused = await runCommand({});
  assert.ok(refused.error);
  assert.match(refused.stderr, /Send graph/);
});
