// tool:read-my-groups and tool:change-my-groups run as the container runs them, against the stand-in records door
// with exactly the rows' rights. Carried from the original package's live sequencing tests (fresh group, existing
// group read back, no-op, a loop across two stored groups), with a tree import and the read path added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { groupRecordId } from '../read-data/group-records.mjs';

const read = rowOf(rows, 'tool:read-my-groups');
const change = rowOf(rows, 'tool:change-my-groups');
const list = id => ({ family: 'shelf', parts: { id } });
const item = id => ({ family: 'shelf-item', parts: { id } });
const keptOf = (run, ref) => run.kept.find(record => record.id === groupRecordId(ref))?.value;

test('a fresh group: nothing to read, one change, one record written', async () => {
  const run = await runRow(change, { changes: [{ kind: 'ensure-group', groupRef: list('fresh') }] });
  assert.equal(run.status, 0, run.error);
  assert.equal(run.result.written, 1);
  assert.deepEqual(keptOf(run, list('fresh')).memberOrder, []);
});

test('an existing group is read back and changed, and an unchanged one is not written', async () => {
  const first = await runRow(change, { changes: [{ kind: 'add-member', groupRef: list('a'), nodeRef: item('s1'), memberId: 'm1' }] });
  const second = await runRow(change, { changes: [{ kind: 'add-member', groupRef: list('a'), nodeRef: item('s2'), memberId: 'm2' }] }, { records: first.kept });
  assert.deepEqual(keptOf(second, list('a')).memberOrder, ['m1', 'm2']);
  const again = await runRow(change, { changes: [{ kind: 'ensure-group', groupRef: list('a') }] }, { records: second.kept });
  assert.equal(again.result.written, 0);
  assert.ok(again.calls.every(call => call.method !== 'records:write'), 'no write is sent when nothing changed');
  assert.deepEqual(again.result.groups.map(group => group.groupRef), [list('a')]);
});

test('a loop across two stored groups is caught, because the change reads both, and nothing is written', async () => {
  const outer = await runRow(change, { changes: [{ kind: 'add-member', groupRef: list('outer'), nodeRef: list('inner'), memberId: 'w' }] });
  const loop = await runRow(change, { changes: [{ kind: 'add-member', groupRef: list('inner'), nodeRef: list('outer'), memberId: 'boom' }] }, { records: outer.kept });
  assert.notEqual(loop.status, 0);
  assert.match(loop.error, /cycle/);
  assert.ok(loop.calls.every(call => call.method !== 'records:write'));
});

test('ungrouping removes the inner group\'s record', async () => {
  const setup = await runRow(change, { changes: [
    { kind: 'add-member', groupRef: list('b'), nodeRef: item('s1'), memberId: 'm1' },
    { kind: 'add-member', groupRef: list('b'), nodeRef: item('s2'), memberId: 'm2' },
    { kind: 'group-members', groupRef: list('b'), memberIds: ['m1', 'm2'], toGroupRef: list('sub'), wrapperMemberId: 'w' },
  ] });
  assert.ok(keptOf(setup, list('sub')));
  const undone = await runRow(change, { changes: [{ kind: 'ungroup-members', groupRef: list('b'), wrapperMemberId: 'w' }] }, { records: setup.kept });
  assert.deepEqual(undone.result.removed, [groupRecordId(list('sub'))]);
  assert.equal(keptOf(undone, list('sub')), undefined);
  assert.deepEqual(keptOf(undone, list('b')).memberOrder, ['m1', 'm2']);
});

test('a tree comes in as groups on top of what is kept, and its root is reported as unplaced', async () => {
  const records = [
    { node_id: 'root', parent_id: null, ordinal: null, role: 'container', title: '' },
    { node_id: 'bread', parent_id: 'root', ordinal: 0, role: 'group', title: 'Bread' },
    { node_id: 'rye', parent_id: 'bread', ordinal: 0, role: 'leaf', title: 'Rye loaf', external_identity: 'https://bakery.example/rye' },
  ];
  const run = await runRow(change, { tree: { family: 'bookmarks', records } });
  assert.equal(run.status, 0, run.error);
  const bread = keptOf(run, { family: 'bookmarks', parts: { node_id: 'bread' } });
  assert.deepEqual(bread.memberOrder, ['rye']);
  assert.deepEqual(bread.members.rye.presentation, { title: 'Rye loaf', external_identity: 'https://bakery.example/rye' });
  assert.deepEqual(run.result.unplaced.map(entry => [entry.node_id, entry.reason]), [['root', 'no_parent']]);
});

test('reading follows nested groups and names records that are not their own group', async () => {
  const setup = await runRow(change, { changes: [
    { kind: 'add-member', groupRef: list('top'), nodeRef: list('mid'), memberId: 'w' },
    { kind: 'add-member', groupRef: list('mid'), nodeRef: item('s1'), memberId: 'm1' },
    { kind: 'add-member', groupRef: list('other'), nodeRef: item('s2'), memberId: 'm2' },
  ] });
  const spoof = { id: groupRecordId(list('mid')), type: 'group', value: keptOf(setup, list('other')) };
  const clean = await runRow(read, { roots: [list('top')] }, { records: setup.kept });
  assert.equal(clean.status, 0, clean.error);
  assert.deepEqual(clean.result.groups.map(group => group.groupRef.parts.id).sort(), ['mid', 'top']);
  assert.equal(clean.result.count, 2);
  const spoofed = await runRow(read, { roots: [list('top')] }, { records: [...setup.kept.filter(record => record.id !== spoof.id), spoof] });
  assert.deepEqual(spoofed.result.skipped, [groupRecordId(list('mid'))]);
});

test('the rows read and write only group records, and the read row only reads', () => {
  assert.deepEqual(read.invoke.records.rights, [{ kind: 'group', operations: ['records:read'] }]);
  assert.deepEqual(change.invoke.records.rights, [{ kind: 'group', operations: ['records:read', 'records:write'] }]);
});
