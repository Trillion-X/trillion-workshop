// Every kind of group change through the one applier, and the hard cases as record writes. Carried from the original
// package's membership-actions tests (the pure transition and the adversarial compositions).
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyGraph, membersOf } from '../read-data/group-graph.mjs';
import { applyGroupChange, changeRoots } from '../read-data/group-changes.mjs';
import { groupRecordId, groupRecordWrites } from '../read-data/group-records.mjs';

const ref = id => ({ family: 'shelf-item', parts: { id } });
const list = id => ({ family: 'shelf', parts: { id } });
const ids = (graph, group) => membersOf(graph, group).map(m => m.memberId);
const apply = (graph, ...ops) => ops.reduce((g, op) => applyGroupChange(g, op), graph);

test('ensure, add, set fields, reorder and remove go through one applier', () => {
  let g = apply(emptyGraph(),
    { kind: 'ensure-group', groupRef: list('a') },
    { kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'm1' },
    { kind: 'add-member', groupRef: list('a'), nodeRef: ref('s2'), memberId: 'm2' },
    { kind: 'set-member-fields', groupRef: list('a'), memberId: 'm1', presentation: { icon: 'star' } },
    { kind: 'reorder-member', groupRef: list('a'), memberId: 'm2', placement: { at: 'start' } });
  assert.deepEqual(ids(g, list('a')), ['m2', 'm1']);
  assert.deepEqual(membersOf(g, list('a'))[1].presentation, { icon: 'star' });
  g = apply(g, { kind: 'remove-member', groupRef: list('a'), memberId: 'm2' });
  assert.deepEqual(ids(g, list('a')), ['m1']);
});

test('patching a presentation merges into the current one without erasing another field', () => {
  const g = apply(emptyGraph(),
    { kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'm1', presentation: { name: 'Rye loaf', tint: 'blue' } },
    { kind: 'patch-member-presentation', groupRef: list('a'), memberId: 'm1', presentation: { placement: { position: 'right' } } });
  assert.deepEqual(membersOf(g, list('a'))[0].presentation, { name: 'Rye loaf', tint: 'blue', placement: { position: 'right' } });
});

test('moving between groups keeps fields, and grouping and ungrouping go back and forth', () => {
  let g = apply(emptyGraph(),
    { kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'm1', presentation: { tint: 'blue' } },
    { kind: 'ensure-group', groupRef: list('b') },
    { kind: 'move-member', groupRef: list('a'), toGroupRef: list('b'), memberId: 'm1' });
  assert.equal(membersOf(g, list('a')).length, 0);
  assert.deepEqual(membersOf(g, list('b'))[0].presentation, { tint: 'blue' });
  g = apply(g,
    { kind: 'add-member', groupRef: list('b'), nodeRef: ref('s2'), memberId: 'm2' },
    { kind: 'group-members', groupRef: list('b'), memberIds: ['m1', 'm2'], toGroupRef: list('sub'), wrapperMemberId: 'w1' });
  assert.deepEqual(ids(g, list('b')), ['w1']);
  assert.deepEqual(ids(g, list('sub')), ['m1', 'm2']);
  g = apply(g, { kind: 'ungroup-members', groupRef: list('b'), wrapperMemberId: 'w1' });
  assert.deepEqual(ids(g, list('b')), ['m1', 'm2']);
  assert.equal(membersOf(g, list('sub')).length, 0);
});

test('an unknown kind is refused, including an object property name', () => {
  assert.throws(() => applyGroupChange(emptyGraph(), { kind: 'nope', groupRef: list('a') }), /unknown group change/);
  assert.throws(() => applyGroupChange(emptyGraph(), { kind: 'constructor', groupRef: list('a') }), /unknown group change/);
});

test('a missing field is named with its kind, and a change without a group address is refused', () => {
  assert.throws(() => applyGroupChange(emptyGraph(), { kind: 'add-member', groupRef: list('a') }), /'nodeRef'/);
  assert.throws(() => applyGroupChange(emptyGraph(), { kind: 'ensure-group', groupRef: 'shelf:a' }), /groupRef/);
});

test('one thing in two lists is two independent members, and only the changed list is written', () => {
  const before = apply(emptyGraph(), { kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'a1' });
  const after = apply(before, { kind: 'add-member', groupRef: list('b'), nodeRef: ref('s1'), memberId: 'b1' });
  assert.deepEqual(groupRecordWrites(before, after).map(write => write.id), [groupRecordId(list('b'))]);
});

test('nesting works at any depth and a loop is refused at any depth', () => {
  const g = apply(emptyGraph(),
    { kind: 'add-member', groupRef: list('root'), nodeRef: list('mid'), memberId: 'w-mid' },
    { kind: 'add-member', groupRef: list('mid'), nodeRef: list('deep'), memberId: 'w-deep' });
  assert.throws(() => applyGroupChange(g, { kind: 'add-member', groupRef: list('deep'), nodeRef: list('root'), memberId: 'boom' }), /cycle/);
});

test('deleting removes the record and making it again writes it again', () => {
  const alive = apply(emptyGraph(), { kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'm1' });
  const deleted = apply(alive, { kind: 'delete-group', groupRef: list('a') });
  assert.deepEqual(groupRecordWrites(alive, deleted), [{ id: groupRecordId(list('a')), type: 'group', value: null }]);
  const recreated = apply(deleted, { kind: 'ensure-group', groupRef: list('a') });
  const writes = groupRecordWrites(deleted, recreated);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].value.memberOrder, []);
});

test('a change that changes nothing writes nothing', () => {
  const g = apply(emptyGraph(), { kind: 'ensure-group', groupRef: list('a') });
  assert.deepEqual(groupRecordWrites(g, apply(g, { kind: 'ensure-group', groupRef: list('a') })), []);
  assert.deepEqual(groupRecordWrites(g, apply(g, { kind: 'remove-member', groupRef: list('a'), memberId: 'ghost' })), []);
});

test('the groups a change touches are its group, its node and its destination', () => {
  assert.equal(changeRoots({ kind: 'move-member', groupRef: list('a'), toGroupRef: list('b'), memberId: 'm' }).length, 2);
  assert.equal(changeRoots({ kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'm' }).length, 2);
});
