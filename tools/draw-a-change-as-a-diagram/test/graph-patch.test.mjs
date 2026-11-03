// tools/draw-a-change-as-a-diagram/test/graph-patch.test.mjs
//
// A stored graph document evolves by typed operations (parts/ui/show/layer-diagram/graph-patch.mjs): a patch is bound to
// the document it was written against and to the document it must give, the first failing operation stops it with a
// machine code and a path, removing a thing removes what points at it, and a person's corrections apply again after
// regeneration and report the selectors that no longer match anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { graphIdentity, validateGraphDocument } from '../do-work/graph-contract.mjs';
import { applyGraphCorrections, applyGraphOps, applyGraphPatch } from '../do-work/graph-patch.mjs';
import patchRules from '../read-data/graph-patch.json' with { type: 'json' };

const base = () => ({
  schema_version: 1, id: 'checkout', label: 'Checkout',
  lanes: [
    { id: 'callers', label: 'Callers', nodes: [{ id: 'web', label: 'Web', delta: 'unchanged' }, { id: 'app', label: 'App', delta: 'unchanged' }] },
    { id: 'core', label: 'Core', nodes: [{ id: 'pay', label: 'Payment', delta: 'modified' }, { id: 'old', label: 'Legacy', delta: 'removed' }] },
  ],
  edges: [
    { from: 'web', to: 'pay', delta: 'unchanged' }, { from: 'app', to: 'pay', delta: 'unchanged' }, { from: 'pay', to: 'old', delta: 'removed' },
  ],
});
const patchOf = (document, ops) => {
  const applied = applyGraphOps(document, ops);
  return { graph: document.id, from: graphIdentity(document), to: applied.ok ? graphIdentity(applied.document) : 'x', ops };
};

test('a patch applies in order, keeps the original untouched and lands on the identity it promised', () => {
  const document = base();
  const before = JSON.stringify(document);
  const ops = [
    { op: 'add_node', lane: 'core', value: { id: 'ledger', label: 'Ledger', delta: 'added' }, after: 'pay' },
    { op: 'add_edge', value: { from: 'pay', to: 'ledger', delta: 'added' } },
    { op: 'set_node', id: 'pay', set: { detail: 'Now retries once' } },
    { op: 'set_document', set: { caption: 'Checkout after the change' } },
  ];
  const result = applyGraphPatch(document, patchOf(document, ops));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(JSON.stringify(document), before, 'the document in hand is never changed');
  assert.deepEqual(result.document.lanes[1].nodes.map((node) => node.id), ['pay', 'ledger', 'old']);
  assert.equal(result.document.lanes[1].nodes[0].detail, 'Now retries once');
  assert.equal(result.document.caption, 'Checkout after the change');
  assert.equal(result.identity, graphIdentity(result.document));
  assert.match(result.identity, /^1f:[0-9a-f]{64}$/);
  assert.equal(validateGraphDocument(result.document).ok, true);
});

test('key order never changes a graph identity, and any content change does', () => {
  const one = base();
  const reordered = { lanes: one.lanes, edges: one.edges, label: one.label, id: one.id, schema_version: 1 };
  assert.equal(graphIdentity(one), graphIdentity(reordered));
  const changed = base(); changed.lanes[0].nodes[0].label = 'Website';
  assert.notEqual(graphIdentity(one), graphIdentity(changed));
});

test('a patch written against another document, another graph, or promising another result is refused', () => {
  const document = base();
  const ops = [{ op: 'set_node', id: 'pay', set: { label: 'Payments' } }];
  const good = patchOf(document, ops);
  const stale = applyGraphPatch({ ...base(), label: 'Checkout v2' }, good);
  assert.deepEqual(stale.errors.map((error) => [error.code, error.path]), [['STALE_BASE', 'patch.from']]);
  assert.match(stale.errors[0].message, /Read the document again/);
  assert.equal(applyGraphPatch(document, { ...good, graph: 'other' }).errors[0].code, 'WRONG_GRAPH');
  assert.equal(applyGraphPatch(document, { ...good, to: graphIdentity(base()) }).errors[0].code, 'RESULT_MISMATCH');
  assert.equal(applyGraphPatch(document, { ...good, extra: 1 }).errors[0].code, 'UNKNOWN_FIELD');
  const { to: _to, ...missing } = good;
  assert.deepEqual(applyGraphPatch(document, missing).errors.map((error) => [error.code, error.path]), [['MISSING_FIELD', 'patch.to']]);
});

test('the first operation that cannot apply stops the patch with its code and path, and nothing lands', () => {
  const document = base();
  const refused = (ops) => applyGraphOps(document, ops).errors.map((error) => [error.code, error.path]);
  assert.deepEqual(refused([{ op: 'set_node', id: 'pay', set: { label: 'A' } }, { op: 'remove_node', id: 'ghost' }, { op: 'set_node', id: 'web', set: { label: 'B' } }]), [['NOT_FOUND', 'ops[1]']]);
  assert.deepEqual(refused([{ op: 'add_node', lane: 'core', value: { id: 'pay', label: 'Again', delta: 'added' } }]), [['ALREADY_EXISTS', 'ops[0].value']]);
  assert.deepEqual(refused([{ op: 'add_node', lane: 'nowhere', value: { id: 'n', label: 'N', delta: 'added' } }]), [['NOT_FOUND', 'ops[0].lane']]);
  assert.deepEqual(refused([{ op: 'add_node', lane: 'core', value: { id: 'n', label: 'N', delta: 'added' }, after: 'ghost' }]), [['AFTER_NOT_FOUND', 'ops[0].after']]);
  assert.deepEqual(refused([{ op: 'set_node', id: 'pay', set: { id: 'renamed' } }]), [['NOT_SETTABLE', 'ops[0].set.id']]);
  assert.deepEqual(refused([{ op: 'set_node', id: 'pay', set: { x: 4 } }]), [['NOT_SETTABLE', 'ops[0].set.x']]);
  assert.deepEqual(refused([{ op: 'explode' }]), [['UNKNOWN_OP', 'ops[0].op']]);
  assert.deepEqual(refused([{ op: 'remove_node' }]), [['MISSING_FIELD', 'ops[0].id']]);
  assert.deepEqual(refused([{ op: 'remove_node', id: 'old', why: 'x' }]), [['UNKNOWN_FIELD', 'ops[0].why']]);
  assert.deepEqual(refused([{ op: 'remove_node', id: 4 }]), [['WRONG_TYPE', 'ops[0].id']]);
  assert.deepEqual(refused('nope'), [['WRONG_TYPE', 'ops']]);
  assert.equal(refused(Array.from({ length: patchRules.most_ops + 1 }, () => ({ op: 'set_document', set: {} })))[0][0], 'TOO_MANY_OPS');
});

test('removing a node removes the edges that point at it, and removing a lane removes its nodes and their edges', () => {
  const document = base();
  const node = applyGraphOps(document, [{ op: 'remove_node', id: 'pay' }]);
  assert.equal(node.ok, true, JSON.stringify(node.errors));
  assert.deepEqual(node.document.edges, [], 'all three edges touched pay or old');
  const lane = applyGraphOps(document, [{ op: 'remove_lane', id: 'core' }]);
  assert.deepEqual(lane.document.lanes.map((found) => found.id), ['callers']);
  assert.deepEqual(lane.document.edges, []);
  const edge = applyGraphOps(document, [{ op: 'remove_edge', from: 'pay', to: 'old' }]);
  assert.equal(edge.document.edges.length, 2);
  assert.equal(applyGraphOps(document, [{ op: 'remove_edge', from: 'pay', to: 'web' }]).errors[0].code, 'NOT_FOUND');
});

test('a node moves between lanes and a value of null clears a field', () => {
  const document = base();
  document.lanes[1].nodes[0].detail = 'was here';
  const moved = applyGraphOps(document, [{ op: 'move_node', id: 'old', lane: 'callers', after: 'web' }, { op: 'set_node', id: 'pay', set: { detail: null } }]);
  assert.equal(moved.ok, true, JSON.stringify(moved.errors));
  assert.deepEqual(moved.document.lanes[0].nodes.map((node) => node.id), ['web', 'old', 'app']);
  assert.equal(Object.hasOwn(moved.document.lanes[1].nodes[0], 'detail'), false);
  assert.equal(applyGraphOps(document, [{ op: 'move_node', id: 'old', lane: 'nowhere' }]).errors[0].code, 'NOT_FOUND');
});

test('a patch that leaves an invalid document is refused with the contract findings', () => {
  const document = base();
  const result = applyGraphOps(document, [{ op: 'add_edge', value: { from: 'web', to: 'ghost', delta: 'added' } }]);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'INVALID_RESULT');
  assert.ok(result.errors.some((error) => error.code === 'BROKEN_REFERENCE' && error.path === 'document.edges[3].to'));
  const positioned = applyGraphOps(document, [{ op: 'set_node', id: 'web', set: { min_height: 900 } }]);
  assert.ok(positioned.errors.some((error) => error.code === 'BAD_FLOOR'));
});

test('operations are DATA: a row added to the table is an operation with no code change', () => {
  const rules = structuredClone(patchRules);
  rules.ops.retitle = { action: 'set', scope: 'document', required: ['set'], optional: [] };
  const result = applyGraphOps(base(), [{ op: 'retitle', set: { label: 'Renamed' } }], rules);
  assert.equal(result.document.label, 'Renamed');
  assert.equal(applyGraphOps(base(), [{ op: 'retitle', set: { label: 'Renamed' } }]).errors[0].code, 'UNKNOWN_OP');
});

test('corrections apply again after regeneration, by id or glob, and report what matched nothing', () => {
  const corrections = [
    { select: 'old', exclude: true },
    { select: 'pay', label: 'Payments', detail: 'Checked by finance' },
    { select: 'a*', lane: 'core' },
    { select: 'gone-since', label: 'Nothing' },
    { select: 'old', label: 'Late fix to an excluded node' },
  ];
  const first = applyGraphCorrections(base(), corrections);
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.deepEqual(first.unmatched, ['gone-since', 'old']);
  assert.deepEqual(first.document.lanes[0].nodes.map((node) => node.id), ['web']);
  assert.deepEqual(first.document.lanes[1].nodes.map((node) => [node.id, node.label, node.detail]), [['pay', 'Payments', 'Checked by finance'], ['app', 'App', undefined]]);
  assert.equal(first.document.edges.some((edge) => edge.to === 'old'), false);
  // Regeneration: the inferred layer changes, the same rows apply again and the inferred document is not edited.
  const regenerated = base(); regenerated.lanes[0].nodes[0].label = 'Website';
  const again = applyGraphCorrections(regenerated, corrections);
  assert.equal(again.ok, true);
  assert.equal(again.document.lanes[0].nodes[0].label, 'Website');
  assert.equal(again.document.lanes[1].nodes[0].label, 'Payments');
  assert.equal(regenerated.lanes[1].nodes[0].label, 'Payment');
});

test('corrections refuse unknown fields, a missing selector, and a result that would be empty', () => {
  assert.deepEqual(applyGraphCorrections(base(), [{ select: 'web', colour: 'red' }]).errors.map((error) => [error.code, error.path]), [['UNKNOWN_FIELD', 'corrections[0].colour']]);
  assert.deepEqual(applyGraphCorrections(base(), [{ exclude: true }]).errors.map((error) => [error.code, error.path]), [['MISSING_FIELD', 'corrections[0].select']]);
  const everything = applyGraphCorrections(base(), [{ select: '*', exclude: true }]);
  assert.equal(everything.ok, false);
  assert.ok(everything.errors.some((error) => error.code === 'EMPTY_GRAPH'));
  assert.equal(applyGraphCorrections(base(), [{ select: 'web', lane: 'nowhere' }]).errors[0].code, 'NOT_FOUND');
});

test('a selector that matches nothing never widens to everything; "all" has to be asked for by name', () => {
  const document = base();
  const none = applyGraphCorrections(document, [{ select: 'removed-last-week', exclude: true }]);
  assert.equal(none.ok, true);
  assert.deepEqual(none.document, document, 'nothing matched, nothing changed');
  assert.deepEqual(none.unmatched, ['removed-last-week']);
  const empty = applyGraphCorrections(document, [{ select: '', exclude: true }]);
  assert.equal(empty.errors[0].code, 'MISSING_FIELD', 'an empty selector is refused, not read as everything');
  const all = applyGraphCorrections(document, [{ select: '*', label: 'Same' }]);
  assert.deepEqual(all.document.lanes.flatMap((lane) => lane.nodes.map((node) => node.label)), ['Same', 'Same', 'Same', 'Same']);
});
