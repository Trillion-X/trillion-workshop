// Steps on a queue, ported from the old changelog-publisher package's record-action-requests tests. What the old
// package sent to its runtime (a workflow target request and an engine write-batch item) is not carried: an action
// that names an owner comes back as a handoff, and every other step comes back as the operation that records it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { buildRecordStep, materializeRecordActionGraph } from '../do-work/record-action-steps.ts';
import { readRecordActionProjection } from '../read-data/read-record-action-projection.ts';

const command = new URL('../do-work/record-a-step.mjs', import.meta.url).pathname;

const ownerAction = {
  id: 'action:any-owner', label: 'Ask owner', method: 'invoke', target: 'owner.target-from-data',
  params: { static_value: 'kept' },
  bindings: [{ key: 'record_id', source: 'selected', path: ['id'] }, { key: 'note', source: 'answers', path: ['note'] }],
};

test('an edit becomes one operation that records the change and the basis it was made on', () => {
  const result = buildRecordStep({ operationId: 'edit-1', method: 'update-field', recordId: 'record:1', fieldPatch: { summary: 'Changed text' }, expectedBasis: 'cursor:1' });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.handoffs, []);
  assert.equal(result.recordOperations.length, 1);
  assert.equal(result.recordOperations[0].kind, 'generic.record-action-operation');
  assert.equal(result.recordOperations[0].method, 'update-field');
  assert.equal(result.recordOperations[0].record_id, 'record:1');
  assert.deepEqual(result.recordOperations[0].field_patch, { summary: 'Changed text' });
  assert.equal(result.recordOperations[0].expected_basis, 'cursor:1');
});

test('an action that names an owner is handed back with its inputs bound, whatever the owner is called', () => {
  const result = buildRecordStep({
    operationId: 'owner-1', descriptorId: ownerAction.id, descriptors: [ownerAction],
    sources: { selected: { id: 'record:1' }, answers: { note: 'Please handle this' } },
  });
  assert.deepEqual(result.recordOperations, []);
  assert.deepEqual(result.trace.bindingKeys, ['record_id', 'note']);
  assert.deepEqual(result.handoffs, [{
    actionId: 'action:any-owner', method: 'invoke', target: 'owner.target-from-data',
    input: { static_value: 'kept', record_id: 'record:1', note: 'Please handle this' },
  }]);
});

test('an action that names a definition instead is handed back with that definition', () => {
  const result = buildRecordStep({
    operationId: 'workflow-1', descriptorId: 'action:flow',
    descriptors: [{ ...ownerAction, id: 'action:flow', target: undefined, definition_id: 'definition:generic-owner-work' }],
    sources: { selected: { id: 'record:1' } },
  });
  assert.equal(result.handoffs[0].definitionId, 'definition:generic-owner-work');
  assert.equal(result.handoffs[0].target, undefined);
});

test('review, receipt and correction steps each carry what they were given', () => {
  const review = buildRecordStep({ operationId: 'review-1', descriptorId: 'action:review', recordId: 'record:1', descriptors: [{ id: 'action:review', method: 'update-field', patch: { reviewed: true } }] });
  const receipt = buildRecordStep({ operationId: 'receipt-1', method: 'append-receipt', recordId: 'record:1', receipt: { id: 'receipt:1', label: 'Owner accepted' } });
  const correction = buildRecordStep({ operationId: 'correction-1', method: 'correct-record', recordId: 'record:1', correction: { id: 'correction:1', before: 'A', after: 'B' } });
  assert.deepEqual(review.recordOperations[0].field_patch, { reviewed: true });
  assert.equal(receipt.recordOperations[0].receipt.id, 'receipt:1');
  assert.equal(correction.recordOperations[0].correction.id, 'correction:1');
});

test('a step that cannot be recorded says why in machine-readable errors', () => {
  assert.deepEqual(buildRecordStep({ operationId: '', descriptorId: 'missing', descriptors: [] }).errors, [
    { code: 'missing-operation', detail: 'operationId is required' },
    { code: 'missing-descriptor', detail: 'missing' },
  ]);
  assert.deepEqual(buildRecordStep({ operationId: 'bad', method: 'domain-shortcut' }).errors, [{ code: 'unknown-method', detail: 'domain-shortcut' }]);
});

test('operations fold into records and receipts that are only added to, and the queue keeps no stored state', () => {
  const next = materializeRecordActionGraph({ state: 'dense', records: [{ id: 'record:1', title: 'One', fields: { keep: 1 } }], receipts: [] }, [{
    kind: 'generic.record-action-operation', operation_id: 'op-1', method: 'append-receipt', record_id: 'record:1',
    field_patch: { reviewed: true }, relationship_patch: { proof: ['proof:1'] }, receipt: { id: 'receipt:1', label: 'Done' },
  }]);
  assert.deepEqual(next.records[0], { id: 'record:1', title: 'One', fields: { keep: 1, reviewed: true }, relationships: { proof: ['proof:1'] } });
  assert.equal(next.receipts[0].kind, 'generic.receipt-record');
  assert.equal(next.receipts[0].record_id, 'record:1');
  assert.equal(next.state, undefined);
  // the reader, not the fold, says how full the queue is
  assert.equal(readRecordActionProjection({ graph: next }).status, 'sparse');
});

test('a step on a record that is not in the queue adds it', () => {
  const next = materializeRecordActionGraph({}, [{ operation_id: 'op-2', record_id: 'record:new', field_patch: { title: 'New' } }]);
  assert.equal(next.records[0].id, 'record:new');
  assert.deepEqual(next.records[0].fields, { title: 'New' });
});

test('the command applies local steps, hands back owner steps and names the steps it refused', async () => {
  const graph = {
    records: [{ id: 'record:1', title: 'Bakery news', fields: {}, relationships: { proof: ['proof:1'] } }],
    actions: [{ id: 'action:publish', method: 'invoke', target: 'owner:any', bindings: [{ key: 'record_id', source: 'selected', path: ['id'] }, { key: 'proof', source: 'selected', path: ['relationships', 'proof'] }] }],
  };
  const steps = [
    { operationId: 'a', method: 'update-field', recordId: 'record:1', fieldPatch: { summary: 'Fresh loaves' } },
    { operationId: 'b', descriptorId: 'action:publish', recordId: 'record:1' },
    { operationId: 'c', method: 'domain-shortcut' },
  ];
  const answer = await new Promise((resolve, reject) => {
    const child = execFile('node', [command], (error, out) => (error ? reject(error) : resolve(JSON.parse(out.trim().split('\n').at(-1)))));
    child.stdin.end(JSON.stringify({ graph, steps }));
  });
  assert.equal(answer.operations.length, 1);
  assert.deepEqual(answer.graph.records[0].fields, { summary: 'Fresh loaves' });
  assert.deepEqual(answer.handoffs[0].input, { record_id: 'record:1', proof: ['proof:1'] });
  assert.deepEqual(answer.refused, [{ operationId: 'c', errors: [{ code: 'unknown-method', detail: 'domain-shortcut' }] }]);
});
