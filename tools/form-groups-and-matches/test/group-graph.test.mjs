// Every membership operation composed with the others, and the one rule (no group contains itself) attacked directly,
// nested, and through grouping. Carried from the original package's group-graph gauntlet, same cases and expectations.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMember, emptyGraph, ensureGroup, getGroup, groupMembers, GroupGraphError, hasGroup, isGroupGraph, memberById,
  membersOf, moveMember, reaches, removeMember, reorderMember, setMemberFields, ungroupMembers,
} from '../read-data/group-graph.mjs';

const ref = (family, id) => ({ family, parts: { id } });
const BOARD = ref('board', 'b1');
const SUB = ref('group', 'sub1');
const SUB2 = ref('group', 'sub2');
const ids = (g, group) => membersOf(g, group).map(m => m.memberId);
const withMembers = (count, group = BOARD) => {
  let g = emptyGraph();
  for (let i = 1; i <= count; i += 1) g = addMember(g, group, ref('tab', `t${i}`), { memberId: `m${i}` });
  return g;
};

test('an empty graph has no groups, and an absent group has no members', () => {
  const g = emptyGraph();
  assert.equal(isGroupGraph(g), true);
  assert.equal(hasGroup(g, BOARD), false);
  assert.deepEqual(membersOf(g, BOARD), []);
});

test('ensureGroup twice is the same graph object', () => {
  const g1 = ensureGroup(emptyGraph(), BOARD);
  const g2 = ensureGroup(g1, BOARD);
  assert.equal(g2, g1);
  assert.equal(hasGroup(g2, BOARD), true);
});

test('members are added in order and a placement sets the position', () => {
  let g = emptyGraph();
  g = addMember(g, BOARD, ref('tab', 't1'), { memberId: 'm1' });
  g = addMember(g, BOARD, ref('tab', 't2'), { memberId: 'm2' });
  g = addMember(g, BOARD, ref('tab', 't0'), { memberId: 'm0', placement: { at: 'start' } });
  g = addMember(g, BOARD, ref('tab', 't15'), { memberId: 'm15', placement: { after: 'm1' } });
  assert.deepEqual(ids(g, BOARD), ['m0', 'm1', 'm15', 'm2']);
});

test('a repeated member id is refused', () => {
  const g = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'm1' });
  assert.throws(() => addMember(g, BOARD, ref('tab', 't2'), { memberId: 'm1' }), GroupGraphError);
});

test('a member id that is also an object property name is an ordinary id', () => {
  let g = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'constructor' });
  g = addMember(g, BOARD, ref('tab', 't2'), { memberId: 'toString' });
  assert.deepEqual(ids(g, BOARD), ['constructor', 'toString']);
  assert.equal(memberById(g, BOARD, 'hasOwnProperty'), null);
  assert.throws(() => addMember(g, BOARD, ref('tab', 't3'), { memberId: 'constructor' }), GroupGraphError);
});

test('removeMember drops the member and its place; an absent member changes nothing', () => {
  let g = withMembers(2);
  assert.equal(removeMember(g, BOARD, 'nope'), g);
  g = removeMember(g, BOARD, 'm1');
  assert.deepEqual(ids(g, BOARD), ['m2']);
  assert.equal(memberById(g, BOARD, 'm1'), null);
});

test('any family is kept as given, never listed in the code', () => {
  let g = emptyGraph();
  const families = ['tab', 'container', 'drawing', 'layout', 'board', 'totally-new-2099'];
  for (const family of families) g = addMember(g, BOARD, ref(family, family), { memberId: family });
  assert.deepEqual(membersOf(g, BOARD).map(m => m.nodeRef.family), families);
});

test('reorderMember moves a member within its group', () => {
  let g = withMembers(4);
  g = reorderMember(g, BOARD, 'm4', { at: 'start' });
  g = reorderMember(g, BOARD, 'm1', { after: 'm3' });
  assert.deepEqual(ids(g, BOARD), ['m4', 'm2', 'm3', 'm1']);
});

test('moveMember to another group keeps id, role and presentation', () => {
  let g = ensureGroup(ensureGroup(emptyGraph(), BOARD), SUB);
  g = addMember(g, BOARD, ref('tab', 't1'), { memberId: 'm1', role: 'cover', presentation: { x: 1 } });
  g = moveMember(g, 'm1', { fromGroupRef: BOARD, toGroupRef: SUB });
  assert.deepEqual(ids(g, BOARD), []);
  const moved = memberById(g, SUB, 'm1');
  assert.equal(moved.role, 'cover');
  assert.deepEqual(moved.presentation, { x: 1 });
  assert.equal(moved.nodeRef.family, 'tab');
});

test('moveMember within one group is a reorder', () => {
  let g = withMembers(3);
  g = moveMember(g, 'm3', { fromGroupRef: BOARD, toGroupRef: BOARD, placement: { at: 'start' } });
  assert.deepEqual(ids(g, BOARD), ['m3', 'm1', 'm2']);
});

test('a group added as a member nests, and reaches() sees it one way only', () => {
  let g = ensureGroup(ensureGroup(emptyGraph(), BOARD), SUB);
  g = addMember(g, SUB, ref('tab', 'inner'), { memberId: 'mi' });
  g = addMember(g, BOARD, SUB, { memberId: 'wrap' });
  assert.equal(reaches(g, BOARD, SUB), true);
  assert.equal(reaches(g, SUB, BOARD), false);
});

test('a group cannot be its own member', () => {
  const g = ensureGroup(emptyGraph(), BOARD);
  assert.throws(() => addMember(g, BOARD, BOARD, { memberId: 'self' }), /cycle/);
});

test('a group cannot contain a group that contains it', () => {
  let g = ensureGroup(ensureGroup(emptyGraph(), BOARD), SUB);
  g = addMember(g, BOARD, SUB, { memberId: 'wrap' });
  assert.throws(() => addMember(g, SUB, BOARD, { memberId: 'back' }), /cycle/);
});

test('a loop through three levels of nesting is refused', () => {
  let g = ensureGroup(ensureGroup(ensureGroup(emptyGraph(), BOARD), SUB), SUB2);
  g = addMember(g, BOARD, SUB, { memberId: 'b->s' });
  g = addMember(g, SUB, SUB2, { memberId: 's->s2' });
  assert.throws(() => addMember(g, SUB2, BOARD, { memberId: 's2->b' }), /cycle/);
});

test('groupMembers puts a selection into a new group at the first selected place', () => {
  let g = withMembers(4);
  g = groupMembers(g, BOARD, ['m2', 'm3'], SUB, { wrapperMemberId: 'w' });
  assert.deepEqual(ids(g, BOARD), ['m1', 'w', 'm4']);
  assert.deepEqual(memberById(g, BOARD, 'w').nodeRef, SUB);
  assert.deepEqual(ids(g, SUB), ['m2', 'm3']);
  assert.equal(hasGroup(g, SUB), true);
});

test('ungroupMembers undoes groupMembers in place and removes the inner group', () => {
  let g = withMembers(4);
  const before = ids(g, BOARD);
  g = groupMembers(g, BOARD, ['m2', 'm3'], SUB, { wrapperMemberId: 'w' });
  g = ungroupMembers(g, BOARD, 'w');
  assert.deepEqual(ids(g, BOARD), before);
  assert.equal(hasGroup(g, SUB), false);
});

test('a group made by grouping can be grouped again', () => {
  let g = withMembers(3);
  g = groupMembers(g, BOARD, ['m1', 'm2'], SUB, { wrapperMemberId: 'w1' });
  g = groupMembers(g, BOARD, ['w1', 'm3'], SUB2, { wrapperMemberId: 'w2' });
  assert.deepEqual(ids(g, BOARD), ['w2']);
  assert.deepEqual(ids(g, SUB2), ['w1', 'm3']);
  assert.deepEqual(memberById(g, SUB2, 'w1').nodeRef, SUB);
  assert.deepEqual(ids(g, SUB), ['m1', 'm2']);
});

test('groupMembers refuses an address that is already a group', () => {
  let g = ensureGroup(emptyGraph(), SUB);
  g = addMember(g, BOARD, ref('tab', 't1'), { memberId: 'm1' });
  assert.throws(() => groupMembers(g, BOARD, ['m1'], SUB, { wrapperMemberId: 'w' }), GroupGraphError);
});

test('setMemberFields sets the opaque fields, and null clears one', () => {
  let g = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'm1', role: 'pinned' });
  g = setMemberFields(g, BOARD, 'm1', { presentation: { color: 'red' } });
  assert.deepEqual(memberById(g, BOARD, 'm1').presentation, { color: 'red' });
  assert.equal(memberById(g, BOARD, 'm1').role, 'pinned');
  g = setMemberFields(g, BOARD, 'm1', { role: null });
  assert.equal('role' in memberById(g, BOARD, 'm1'), false);
});

test('a change elsewhere leaves an untouched group as the same object', () => {
  let g = ensureGroup(ensureGroup(emptyGraph(), BOARD), SUB);
  g = addMember(g, SUB, ref('tab', 'x'), { memberId: 'sx' });
  const subBefore = getGroup(g, SUB);
  g = addMember(g, BOARD, ref('tab', 'y'), { memberId: 'by' });
  assert.equal(getGroup(g, SUB), subBefore);
});

test('a graph goes through JSON and back unchanged', () => {
  let g = withMembers(3);
  g = groupMembers(g, BOARD, ['m1', 'm2'], SUB, { wrapperMemberId: 'w' });
  const roundTripped = JSON.parse(JSON.stringify(g));
  assert.equal(isGroupGraph(roundTripped), true);
  assert.deepEqual(roundTripped, g);
});
