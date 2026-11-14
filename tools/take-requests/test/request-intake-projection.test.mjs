import assert from 'node:assert/strict';
import { readRequestIntakeSurface } from '../read-data/request-intake-projection.ts';

const shape = {
  id: 'shape:anything',
  label: 'Any configurable shape',
  fields: [
    { id: 'field:a', label: 'First field', order: 2 },
    { id: 'field:b', label: 'Second field', order: 1 },
    { id: 'field:c', label: 'Third field', order: 3 },
  ],
};

const action = {
  id: 'action:any-owner',
  label: 'Ask an owner to do work',
  order: 1,
  target: 'slot::workflow',
  operation: 'owner.work',
};

const receipt = {
  ref: 'receipt:any-owner:1',
  owner_ref: 'owner:anything',
  title: 'Owner accepted the handoff',
  process_session_ref: 'process_session:anything',
};

const surface = readRequestIntakeSurface({
  shapes: [shape],
  views: [{ id: 'view:any', label: 'Any view', order: 1 }],
  states: [{ id: 'state:renamed-anything', label: 'Renamed by data', order: 1 }],
  actions: [action],
  receipts: [receipt],
  selectedRecordId: 'record:1',
  instances: [{
    id: 'record:1',
    shape_id: 'shape:anything',
    title: 'One submitted record',
    state_id: 'state:renamed-anything',
    values: {
      'field:a': true,
      'field:b': ['x', 'y'],
      'field:c': { opaque: true },
    },
    linked_receipt_refs: ['receipt:any-owner:1', 'receipt:missing'],
    action_descriptor_ids: ['action:any-owner'],
  }],
});

assert.equal(surface.status, 'sparse');
assert.deepEqual(surface.selectedShape?.fields.map((field) => field.id), ['field:b', 'field:a', 'field:c']);
assert.deepEqual(surface.selectedRecord?.values.map((value) => value.valueText), ['2 values', 'Yes', 'Available']);
assert.deepEqual(surface.selectedRecord?.linkedReceipts.map((entry) => entry.ref), ['receipt:any-owner:1']);
assert.deepEqual(surface.selectedRecord?.actions.map((entry) => entry.id), ['action:any-owner']);

const empty = readRequestIntakeSurface({ shapes: [shape], instances: [] });
assert.equal(empty.status, 'empty');
assert.equal(empty.selectedRecord, null);

const dense = readRequestIntakeSurface({
  shapes: [shape],
  instances: Array.from({ length: 13 }, (_, index) => ({
    id: `record:${index}`,
    shape_id: 'shape:anything',
    title: `Record ${index}`,
  })),
});
assert.equal(dense.status, 'dense');

const conflict = readRequestIntakeSurface({
  shapes: [shape],
  instances: [{ id: 'record:x', shape_id: 'shape:anything', title: 'X', issue: 'owner rejected descriptor' }],
});
assert.equal(conflict.status, 'conflict');

const arbitrary = readRequestIntakeSurface({
  shapes: [{ id: 'shape:new', label: 'New', fields: [{ id: 'field:new', label: 'Brand new value kind', value_kind: 'anything-humans-add-later' }] }],
  actions: [{ id: 'action:new-owner', label: 'New owner', target: 'owner:any-new-target' }],
  states: [{ id: 'state:any-future-word', label: 'Any future word' }],
  instances: [{ id: 'record:new', shape_id: 'shape:new', values: { 'field:new': 'Works without code edit' } }],
});
assert.equal(arbitrary.selectedRecord?.values[0].valueText, 'Works without code edit');

console.log('[request-intake] projection built', {
  shapes: surface.shapes.length,
  records: surface.records.length,
  actions: surface.actions.length,
});
