// The create-a-space outcome (the old create_membership) on the space-members owner: a person starts a shared space with
// themselves as its owner and first member. Every value here is made up. The run reads no store; the test stores `keep`
// back, as the caller's AI would.
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../tool-rows.json' with { type: 'json' };
import { createASpace, leaveASpace } from '../do-work/space-members.mjs';
import { KINDS, rowId } from '../read-data/space-rows.mjs';

const made = input => createASpace({ space: 'sample-hike', subject: 'owner@example.com', title: 'Sample hike', records: [], ...input });
const keptOf = (answer, type) => (answer.keep ?? []).find(row => row.type === type);

test('starting a space keeps its space row and the owner as first member, and asks the store for nothing', () => {
  const answer = made({ label: 'group', join: [{ free: true }] });
  assert.equal(answer.created, true);
  assert.equal(answer.state, 'member');
  assert.equal(answer.member_type, 'owner');
  const space = keptOf(answer, KINDS.space);
  assert.equal(space.id, rowId('space', 'sample-hike'));
  assert.deepEqual(space.value, { title: 'Sample hike', owner: 'owner@example.com', label: 'group', config: { join: [{ free: true }] } });
  assert.equal(space.expected, null);
  const member = keptOf(answer, KINDS.member);
  assert.equal(member.id, rowId('member', 'sample-hike', 'owner@example.com'));
  assert.equal(member.value.member_type, 'owner');
  assert.equal(member.value.how, 'owner');
  assert.equal(member.value.state, 'member');
});

test('the owner stored from the answer is not left by the leave tool: the owner cannot leave without handing the space over', () => {
  const answer = made({});
  const records = answer.keep.map(row => ({ id: row.id, type: row.type, value: row.value }));
  assert.throws(() => leaveASpace({ records, space: 'sample-hike', subject: 'owner@example.com' }), /cannot leave/);
});

test('a space id already in the records is refused, and a missing title is refused', () => {
  const records = [{ id: rowId('space', 'sample-hike'), type: KINDS.space, value: { title: 'Taken', owner: 'a@example.com' } }];
  assert.throws(() => createASpace({ records, space: 'sample-hike', subject: 'owner@example.com', title: 'Again' }), /already exists/);
  assert.throws(() => made({ title: undefined }), /title must say/);
});

test('a label outside the made labels is refused: a community is joined by its own rules', () => {
  assert.throws(() => made({ label: 'community' }), /label must be one of/);
});

test('join rows that do not hold are refused before anything is kept', () => {
  assert.throws(() => made({ join: [{ nonsense: true }] }));
  assert.throws(() => made({ join: 'free' }), /join must be a list/);
});

test('the tool row sits beside tool:leave-a-space and runs createASpace', () => {
  const row = rows.records.find(record => record.payload.id === 'tool:create-a-space');
  assert.ok(row, 'the row exists');
  assert.equal(row.payload.invoke.argv.at(-1), 'createASpace');
  assert.ok(rows.records.some(record => record.payload.id === 'tool:leave-a-space'));
});
