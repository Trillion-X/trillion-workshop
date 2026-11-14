import assert from 'node:assert/strict';
import { recordRequestIntakeOwnerReceipt, requestRequestIntakeChange } from '../do-work/request-intake-actions.ts';
import { readRequestIntakeSurface } from '../read-data/request-intake-projection.ts';

const receipt = recordRequestIntakeOwnerReceipt({
  receiptRef: 'receipt:opaque-owner:1',
  ownerRef: 'owner:opaque',
  title: 'Owner finished work',
  summary: 'Done',
  processSessionRef: 'process_session:opaque',
  raw: { privateOwnerShape: true },
});

assert.deepEqual(receipt, {
  kind: 'generic.owner-receipt',
  ref: 'receipt:opaque-owner:1',
  owner_ref: 'owner:opaque',
  title: 'Owner finished work',
  summary: 'Done',
  process_session_ref: 'process_session:opaque',
  observed_at: undefined,
  raw: { privateOwnerShape: true },
});

const surface = readRequestIntakeSurface({
  shapes: [{ id: 'shape:any', label: 'Any', fields: [] }],
  receipts: [receipt, {
    ref: 'receipt:second-owner:1',
    owner_ref: 'owner:second',
    title: 'Second owner finished work',
  }],
  instances: [{
    id: 'record:any',
    shape_id: 'shape:any',
    linked_receipt_refs: ['receipt:opaque-owner:1', 'receipt:second-owner:1'],
  }],
});

assert.deepEqual(surface.selectedRecord?.linkedReceipts.map((entry) => entry.ownerRef), ['owner:opaque', 'owner:second']);
assert.equal(surface.selectedRecord?.linkedReceipts[0].processSessionRef, 'process_session:opaque');
assert.deepEqual(surface.selectedRecord?.linkedReceipts[0].raw, { privateOwnerShape: true });

const change = requestRequestIntakeChange({
  operationId: 'operation:receipt-link',
  recordRef: 'record:any',
  receiptRef: 'receipt:linked-by-change',
  receipt: {
    ownerRef: 'owner:any',
    title: 'Owner result linked by change',
    processSessionRef: 'process_session:linked-by-change',
  },
});
assert.equal(change.receiptLinks[0].kind, 'generic.owner-receipt');
assert.equal(change.receiptLinks[0].owner_ref, 'owner:any');
assert.equal(change.receiptLinks[0].process_session_ref, 'process_session:linked-by-change');

console.log('[request-intake] owner receipt linked', { receiptRef: receipt.ref });
console.log('[request-intake] process proof linked', { processSessionRef: receipt.process_session_ref });
