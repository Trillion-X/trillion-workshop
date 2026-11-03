// tools/lay-out-a-diagram: what changed between two versions of a diagram.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTwoDiagrams } from '../do-work/requests.mjs';

const before = {
  nodes: [{ id: 'Order received' }, { id: 'Packed', label: 'Packing' }, { id: 'Shipped', lane: 'Warehouse' }, { id: 'Cancelled' }],
  edges: [
    { id: 'e-pack', from: 'Order received', to: 'Packed' },
    { id: 'e-ship', from: 'Packed', to: 'Shipped', label: 'when ready' },
    { from: 'Order received', to: 'Cancelled', label: 'customer asks' },
    { from: 'Packed', to: 'Cancelled' },
    { from: 'Order received', to: 'Shipped', label: 'express' },
  ],
};
const after = {
  nodes: [{ id: 'Order received' }, { id: 'Packed', label: 'Packed and checked' }, { id: 'Shipped', lane: 'Dispatch', style: { fill: '#eeeeee' } }, { id: 'Delivered' }],
  edges: [
    { id: 'e-pack', from: 'Order received', to: 'Packed' },
    { id: 'e-ship', from: 'Packed', to: 'Delivered', label: 'when ready' },
    { from: 'Order received', to: 'Shipped', label: 'express' },
    { from: 'Shipped', to: 'Delivered' },
  ],
};

test('boxes added, removed and changed, with what changed on each, ordered by id', () => {
  const { nodes } = compareTwoDiagrams({ before, after });
  assert.deepEqual(nodes.added, ['Delivered']);
  assert.deepEqual(nodes.removed, ['Cancelled']);
  assert.deepEqual(nodes.changed, [
    { id: 'Packed', changes: [{ field: 'label', before: 'Packing', after: 'Packed and checked' }] },
    { id: 'Shipped', changes: [{ field: 'lane', before: 'Warehouse', after: 'Dispatch' }, { field: 'style', before: null, after: { fill: '#eeeeee' } }] },
  ]);
});

test('arrows match by id when they have one, else by from, to and label', () => {
  const { edges } = compareTwoDiagrams({ before, after });
  assert.deepEqual(edges.added, ['Shipped -> Delivered']);
  assert.deepEqual(edges.removed, ['Order received -> Cancelled : customer asks', 'Packed -> Cancelled']);
  assert.deepEqual(edges.changed, [{ id: 'e-ship', changes: [{ field: 'to', before: 'Shipped', after: 'Delivered' }] }]);
});

test('two identical diagrams have no difference, whatever the order of the lists or of the keys', () => {
  const same = compareTwoDiagrams({ before, after: { nodes: [...before.nodes].reverse(), edges: [...before.edges].reverse() } });
  assert.deepEqual(same, { nodes: { added: [], removed: [], changed: [] }, edges: { added: [], removed: [], changed: [] } });
});

test('a request missing a side, or an arrow to a box that is not there, is refused with a sentence', () => {
  assert.throws(() => compareTwoDiagrams({ before }), /after must be an object/);
  assert.throws(() => compareTwoDiagrams({ before, after: { nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'b' }] } }), /after\.edges\[0\] names "b" in to/);
});
