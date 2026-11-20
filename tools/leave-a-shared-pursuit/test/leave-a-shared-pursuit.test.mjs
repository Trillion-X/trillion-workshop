import test from 'node:test';
import assert from 'node:assert/strict';
import { leaveASharedPursuit } from '../do-work/leave-a-shared-pursuit.mjs';

// Two test people only: person:gate-test is a member; person:gate-test-two runs the space.
const MEMBER = 'person:gate-test';
const OWNER = 'person:gate-test-two';
const SPACE = 'gate-club';
const PURSUIT = 'pursuit:gate-club';
const memberId = subject => `record:space-member:${SPACE}:${encodeURIComponent(subject)}`;
const space = { title: 'Gate club', owner: OWNER, config: { join: [{ free: true }] } };
const records = () => [
  { id: `record:space:${SPACE}`, type: 'record:space', value: space },
  { id: memberId(OWNER), type: 'record:space-member', value: { space: SPACE, subject: OWNER, member_type: 'owner', state: 'member', how: 'owner', joined_at: '2026-01-01T00:00:00.000Z' } },
  { id: memberId(MEMBER), type: 'record:space-member', value: { space: SPACE, subject: MEMBER, member_type: 'member', state: 'member', how: 'free', joined_at: '2026-02-01T00:00:00.000Z' } },
  { id: PURSUIT, type: 'pursuit', value: { id: PURSUIT, title: 'Gate club', space_id: SPACE, status: 'active' } },
];
const apply = (rows, keep) => rows.map(row => keep.find(k => k.id === row.id) ? { id: row.id, type: row.type, value: keep.find(k => k.id === row.id).value } : row);

test('a member leaves: their own membership is marked left and the pursuit ends for them', () => {
  const result = leaveASharedPursuit({ pursuit: PURSUIT, subject: MEMBER, records: records() });
  assert.equal(result.left, SPACE);
  assert.equal(result.membership, 'left');
  const member = result.keep.find(k => k.id === memberId(MEMBER));
  assert.equal(member.value.state, 'left');
  assert.equal(result.keep.find(k => k.id === PURSUIT).value.status, 'ended');
});

test('after leaving, the same person is refused: the pursuit is no longer theirs', () => {
  const first = leaveASharedPursuit({ pursuit: PURSUIT, subject: MEMBER, records: records() });
  assert.throws(() => leaveASharedPursuit({ pursuit: PURSUIT, subject: MEMBER, records: apply(records(), first.keep) }),
    /not one of this person's pursuits/);
});

test('the person who runs the space cannot leave it: refused, and nothing is kept', () => {
  assert.throws(() => leaveASharedPursuit({ pursuit: PURSUIT, subject: OWNER, records: records() }), /hand it over first/);
});

test('only the caller\'s own membership changes; the other person\'s row is never kept', () => {
  const { keep } = leaveASharedPursuit({ pursuit: PURSUIT, subject: MEMBER, records: records() });
  assert.deepEqual(keep.map(k => k.id).sort(), [PURSUIT, memberId(MEMBER)].sort());
  assert.equal(keep.some(k => k.id === memberId(OWNER)), false);
});

test('a pursuit that is not in the caller\'s records is refused', () => {
  assert.throws(() => leaveASharedPursuit({ pursuit: 'pursuit:someone-else', subject: MEMBER, records: records() }), /not one of this person's pursuits/);
});

test('a pursuit with no shared space ends for the person with nothing else to change', () => {
  const solo = [{ id: 'pursuit:solo', type: 'pursuit', value: { id: 'pursuit:solo', title: 'Solo', status: 'active' } }];
  const result = leaveASharedPursuit({ pursuit: 'pursuit:solo', subject: MEMBER, records: solo });
  assert.equal(result.left, null);
  assert.deepEqual(result.keep.map(k => k.id), ['pursuit:solo']);
});

test('a request without the pursuit or the person is refused', () => {
  assert.throws(() => leaveASharedPursuit({ subject: MEMBER, records: records() }), /pursuit \(the pursuit id\) and subject/);
  assert.throws(() => leaveASharedPursuit({ pursuit: PURSUIT, records: records() }), /pursuit \(the pursuit id\) and subject/);
});
