// tool:read-my-groups and tool:change-my-groups run as the container runs them, on the group records the caller hands in
// as `records`. Neither row reaches a store: a change answers the changed records as `keep` (each with the value it
// expected), and the test puts them in a small in-memory store that refuses a write whose expected record moved. Carried
// from the original package's live sequencing tests (fresh group, existing group read back, no-op, a loop across two
// stored groups), with a tree import, the read path and a spoofed record added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf, rightsOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
import { groupRecordId } from '../read-data/group-records.mjs';

const read = rowOf(rows, 'tool:read-my-groups');
const change = rowOf(rows, 'tool:change-my-groups');
const list = id => ({ family: 'shelf', parts: { id } });
const item = id => ({ family: 'shelf-item', parts: { id } });

// The keep rows put in the store: each is refused whole when the record it expected is not as it was handed in.
function stored(records, keep) {
  const held = new Map(records.map(record => [record.id, record]));
  for (const write of keep) {
    const now = held.get(write.id) ?? null;
    const same = write.expected === null ? now === null
      : now !== null && now.type === write.expected.type && JSON.stringify(now.value) === JSON.stringify(write.expected.value);
    assert.ok(same, `${write.id} is not as the answer expected`);
  }
  for (const write of keep) {
    if (write.value === null) held.delete(write.id);
    else held.set(write.id, { id: write.id, type: write.type, value: write.value });
  }
  return [...held.values()];
}

// One change over the records the store holds now; the answer's keep is put in the store, and the store is what it holds after.
async function changeOf(records, input) {
  const run = await answerOf(change, { ...input, records });
  assert.equal(run.status, 0, run.error);
  assert.deepEqual(run.calls, [], 'no store call was made');
  return { run, records: stored(records, run.result.keep) };
}
const valueOf = (records, ref) => records.find(record => record.id === groupRecordId(ref))?.value;

test('a fresh group: nothing to read, one change, one record kept for a new group', async () => {
  const { run } = await changeOf([], { changes: [{ kind: 'ensure-group', groupRef: list('fresh') }] });
  assert.equal(run.result.written, 1);
  assert.deepEqual(run.result.keep.map(write => [write.id, write.expected]), [[groupRecordId(list('fresh')), null]]);
  assert.deepEqual(run.result.keep[0].value.memberOrder, []);
});

test('an existing group is read back and changed, and an unchanged one is not kept again', async () => {
  const first = await changeOf([], { changes: [{ kind: 'add-member', groupRef: list('a'), nodeRef: item('s1'), memberId: 'm1' }] });
  const second = await changeOf(first.records, { changes: [{ kind: 'add-member', groupRef: list('a'), nodeRef: item('s2'), memberId: 'm2' }] });
  assert.deepEqual(valueOf(second.records, list('a')).memberOrder, ['m1', 'm2']);
  assert.equal(second.run.result.keep[0].expected.value.memberOrder.length, 1, 'the expected record is the one handed in');
  const again = await changeOf(second.records, { changes: [{ kind: 'ensure-group', groupRef: list('a') }] });
  assert.equal(again.run.result.written, 0);
  assert.deepEqual(again.run.result.keep, []);
  assert.deepEqual(again.run.result.groups.map(group => group.groupRef), [list('a')]);
});

test('a loop across two stored groups is caught, because the change reads both, and nothing is kept', async () => {
  const outer = await changeOf([], { changes: [{ kind: 'add-member', groupRef: list('outer'), nodeRef: list('inner'), memberId: 'w' }] });
  const loop = await answerOf(change, { changes: [{ kind: 'add-member', groupRef: list('inner'), nodeRef: list('outer'), memberId: 'boom' }], records: outer.records });
  assert.notEqual(loop.status, 0);
  assert.match(loop.error, /cycle/);
  assert.ok(loop.calls.every(call => call.method !== 'records:write'));
});

test('ungrouping keeps the inner group\'s record removed (value null)', async () => {
  const setup = await changeOf([], { changes: [
    { kind: 'add-member', groupRef: list('b'), nodeRef: item('s1'), memberId: 'm1' },
    { kind: 'add-member', groupRef: list('b'), nodeRef: item('s2'), memberId: 'm2' },
    { kind: 'group-members', groupRef: list('b'), memberIds: ['m1', 'm2'], toGroupRef: list('sub'), wrapperMemberId: 'w' },
  ] });
  assert.ok(valueOf(setup.records, list('sub')));
  const undone = await changeOf(setup.records, { changes: [{ kind: 'ungroup-members', groupRef: list('b'), wrapperMemberId: 'w' }] });
  assert.deepEqual(undone.run.result.removed, [groupRecordId(list('sub'))]);
  assert.deepEqual(undone.run.result.keep.find(write => write.id === groupRecordId(list('sub'))).value, null);
  assert.equal(valueOf(undone.records, list('sub')), undefined);
  assert.deepEqual(valueOf(undone.records, list('b')).memberOrder, ['m1', 'm2']);
});

test('a tree comes in as groups on top of what is held, and its root is reported as unplaced', async () => {
  const records = [
    { node_id: 'root', parent_id: null, ordinal: null, role: 'container', title: '' },
    { node_id: 'bread', parent_id: 'root', ordinal: 0, role: 'group', title: 'Bread' },
    { node_id: 'rye', parent_id: 'bread', ordinal: 0, role: 'leaf', title: 'Rye loaf', external_identity: 'https://bakery.example/rye' },
  ];
  const run = await answerOf(change, { tree: { family: 'bookmarks', records }, records: [] });
  assert.equal(run.status, 0, run.error);
  const bread = run.result.keep.find(write => write.id === groupRecordId({ family: 'bookmarks', parts: { node_id: 'bread' } })).value;
  assert.deepEqual(bread.memberOrder, ['rye']);
  assert.deepEqual(bread.members.rye.presentation, { title: 'Rye loaf', external_identity: 'https://bakery.example/rye' });
  assert.deepEqual(run.result.unplaced.map(entry => [entry.node_id, entry.reason]), [['root', 'no_parent']]);
});

test('reading follows nested groups in the records handed in, and names a record that is not its own group', async () => {
  const setup = await changeOf([], { changes: [
    { kind: 'add-member', groupRef: list('top'), nodeRef: list('mid'), memberId: 'w' },
    { kind: 'add-member', groupRef: list('mid'), nodeRef: item('s1'), memberId: 'm1' },
    { kind: 'add-member', groupRef: list('other'), nodeRef: item('s2'), memberId: 'm2' },
  ] });
  const spoof = { id: groupRecordId(list('mid')), type: 'group', value: valueOf(setup.records, list('other')) };
  const clean = await answerOf(read, { roots: [list('top')], records: setup.records });
  assert.equal(clean.status, 0, clean.error);
  assert.deepEqual(clean.result.groups.map(group => group.groupRef.parts.id).sort(), ['mid', 'top']);
  assert.equal(clean.result.count, 2);
  const spoofed = await answerOf(read, { roots: [list('top')], records: [...setup.records.filter(record => record.id !== spoof.id), spoof] });
  assert.deepEqual(spoofed.result.skipped, [groupRecordId(list('mid'))]);
});

test('the rows reach no store: they declare no stored rights and take their records as input', () => {
  assert.deepEqual(rightsOf(read), []);
  assert.deepEqual(rightsOf(change), []);
  for (const row of [read, change]) {
    assert.equal(row.invoke.records, undefined, row.id);
    assert.ok(row.input_schema.properties.records, `${row.id} takes records`);
    assert.equal(row.input_schema.properties.stored, undefined, row.id);
  }
  assert.ok(change.output_schema.properties.keep, 'the change answers keep');
});
