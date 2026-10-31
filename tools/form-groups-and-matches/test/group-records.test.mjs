// Groups as records: reading folds records into a graph, writing gives only what changed. Carried from the original
// package's record codec and write-batch tests; the old engine write-batch envelope became { id, type, value } records
// and a removed group is value null instead of a status field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMember, emptyGraph, ensureGroup, groupMembers, membersOf, moveMember, ungroupMembers } from '../read-data/group-graph.mjs';
import { foldGroupRecords, GROUP_RECORD_TYPE, groupRecordId, groupRecordWrites } from '../read-data/group-records.mjs';

const ref = (family, id) => ({ family, parts: { id } });
const BOARD = ref('board', 'b1');
const SUB = ref('group', 'sub1');
const ids = (graph, group) => membersOf(graph, group).map(m => m.memberId);
const toRecords = graph => Object.values(graph.groups).map(group => ({ id: groupRecordId(group.groupRef), type: GROUP_RECORD_TYPE, value: group }));
const fold = records => foldGroupRecords(records).graph;
const withMembers = (count, group = BOARD) => {
  let g = emptyGraph();
  for (let i = 1; i <= count; i += 1) g = addMember(g, group, ref('tab', `t${i}`), { memberId: `m${i}` });
  return g;
};

test('a record id is the same for the same address whatever the order of its parts, and escapes its pieces', () => {
  assert.equal(groupRecordId({ family: 'shelf', parts: { b: '2', a: '1' } }), groupRecordId({ family: 'shelf', parts: { a: '1', b: '2' } }));
  assert.equal(groupRecordId({ family: 'a:b', parts: { 'x&y': 'p=q' } }), 'group:a%3Ab:x%26y=p%3Dq');
  assert.notEqual(groupRecordId({ family: 'a', parts: { b: 'c' } }), groupRecordId({ family: 'a', parts: { 'b=c': '' } }));
});

test('records fold into a graph', () => {
  const folded = fold(toRecords(withMembers(2)));
  assert.deepEqual(ids(folded, BOARD), ['m1', 'm2']);
});

test('malformed records are left out and named, and a later record of a group wins', () => {
  const good = toRecords(withMembers(1))[0];
  const newer = toRecords(withMembers(2))[0];
  const { graph, skipped } = foldGroupRecords([
    { id: 'x', type: GROUP_RECORD_TYPE, value: 'not a group' },
    { id: groupRecordId(BOARD), type: GROUP_RECORD_TYPE, value: { junk: true } },
    good,
    newer,
  ]);
  assert.deepEqual(ids(graph, BOARD), ['m1', 'm2']);
  assert.deepEqual(skipped, ['x', groupRecordId(BOARD)]);
});

test('no records is an empty graph', () => {
  assert.deepEqual(fold([]).groups, {});
});

test('a removed record (value null) is no group', () => {
  const live = toRecords(withMembers(1))[0];
  assert.deepEqual(fold([live, { ...live, value: null }]).groups, {});
});

test('one added member writes one group; an unrelated group is not written', () => {
  let before = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'm1' });
  before = addMember(before, SUB, ref('tab', 's1'), { memberId: 'sm1' });
  const after = addMember(before, BOARD, ref('tab', 't2'), { memberId: 'm2' });
  const writes = groupRecordWrites(before, after);
  assert.deepEqual(writes.map(write => write.id), [groupRecordId(BOARD)]);
  assert.deepEqual(writes[0].value.memberOrder, ['m1', 'm2']);
  assert.equal(writes[0].type, GROUP_RECORD_TYPE);
});

test('grouping writes the parent and the new group, and removes nothing', () => {
  const before = withMembers(3);
  const after = groupMembers(before, BOARD, ['m1', 'm2'], SUB, { wrapperMemberId: 'w' });
  const writes = groupRecordWrites(before, after);
  assert.deepEqual(writes.map(write => write.id).sort(), [groupRecordId(BOARD), groupRecordId(SUB)].sort());
  assert.ok(writes.every(write => write.value !== null));
});

test('moving a member writes both groups with no per-operation code', () => {
  let g = ensureGroup(ensureGroup(emptyGraph(), BOARD), SUB);
  g = addMember(g, BOARD, ref('tab', 't1'), { memberId: 'm1' });
  const after = moveMember(g, 'm1', { fromGroupRef: BOARD, toGroupRef: SUB });
  assert.deepEqual(groupRecordWrites(g, after).map(write => write.id).sort(), [groupRecordId(BOARD), groupRecordId(SUB)].sort());
});

test('ungrouping writes the parent and removes the inner group', () => {
  const grouped = groupMembers(withMembers(3), BOARD, ['m1', 'm2'], SUB, { wrapperMemberId: 'w' });
  const ungrouped = ungroupMembers(grouped, BOARD, 'w');
  const writes = groupRecordWrites(grouped, ungrouped);
  assert.deepEqual(writes.filter(write => write.value !== null).map(write => write.id), [groupRecordId(BOARD)]);
  assert.deepEqual(writes.filter(write => write.value === null).map(write => write.id), [groupRecordId(SUB)]);
});

test('no change writes nothing', () => {
  const g = withMembers(1);
  assert.deepEqual(groupRecordWrites(g, g), []);
  assert.deepEqual(groupRecordWrites(g, JSON.parse(JSON.stringify(g))), []);
});

test('records, a change and its writes applied, then read again, give the changed graph', () => {
  const folded = fold(toRecords(withMembers(4)));
  const after = groupMembers(folded, BOARD, ['m2', 'm3'], SUB, { wrapperMemberId: 'w' });
  const store = new Map(toRecords(folded).map(record => [record.id, record]));
  for (const write of groupRecordWrites(folded, after)) store.set(write.id, write);
  const refolded = fold([...store.values()]);
  assert.deepEqual(ids(refolded, BOARD), ['m1', 'w', 'm4']);
  assert.deepEqual(ids(refolded, SUB), ['m2', 'm3']);
});

test('a record kept under another group\'s id cannot speak for that group', () => {
  const legitValue = Object.values(withMembers(1).groups)[0];
  const legit = { id: groupRecordId(BOARD), type: GROUP_RECORD_TYPE, value: legitValue };
  const spoof = { id: groupRecordId(SUB), type: GROUP_RECORD_TYPE, value: { ...legitValue, memberOrder: [], members: {} } };
  const { graph, skipped } = foldGroupRecords([legit, spoof]);
  assert.deepEqual(ids(graph, BOARD), ['m1']);
  assert.deepEqual(skipped, [groupRecordId(SUB)]);
});

test('a missing or null record in the list is passed over', () => {
  const legit = toRecords(withMembers(1))[0];
  assert.doesNotThrow(() => foldGroupRecords([null, legit, undefined]));
  assert.deepEqual(ids(fold([null, legit]), BOARD), ['m1']);
});
