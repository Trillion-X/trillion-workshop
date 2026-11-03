// What adding a tool to a space would give each member. The assertions of Trillion-X/trillion test/access-impact.test.mjs,
// asked of accessImpact itself instead of through the old space route (which stays in the old tree).
import assert from 'node:assert/strict';
import test from 'node:test';
import { accessImpact } from '../src/access-impact.mjs';

const descriptor = { id: 'tool:proof', job: 'Read a document', placements: ['placement:your-computer'], needs: { network_egress: true }, output_schema: { type: 'object' }, input_schema: { type: 'object' } };
const members = [{ member_id: 'relay:ana', name: 'Ana' }, { member_id: 'relay:ben', name: 'Ben' }];
const held = { 'relay:ben': ['discover', 'describe'] };

test('the owner sees, per member, what the tool would add beyond what they already hold and that they must decide it', () => {
  const body = accessImpact({ descriptor, toolVersion: 'v-sample', members, held });
  assert.equal(body.tool_version, 'v-sample', 'the exact immutable version that would be approved');
  assert.deepEqual(body.members.find(member => member.member_id === 'relay:ben'), { member_id: 'relay:ben', name: 'Ben', gains: ['run', 'read'], already: ['discover', 'describe'] });
  assert.deepEqual(body.members.find(member => member.member_id === 'relay:ana').gains, ['discover', 'describe', 'run', 'read']);
  assert.deepEqual(body.reaches.map(row => row.id), ['runs-on-your-computer', 'sends-off-the-device', 'keeps-results']);
  assert.equal(body.needs_owner, true);
  assert.match(body.says.join(' '), /You decide this one yourself: It runs on a member's own computer\./);
  assert.match(body.says.join(' '), /whoever joins later/);
});

test('for one member and discover only it names nobody to decide and everything already held says so', () => {
  const body = accessImpact({ descriptor, toolVersion: 'v-sample', operations: ['discover', 'describe'], memberId: 'relay:ben', members, held });
  assert.equal(body.everyone, false);
  assert.deepEqual(body.members.map(member => member.gains), [[]]);
  assert.equal(body.needs_owner, false);
  assert.match(body.says[0], /already holds this/);
  assert.throws(() => accessImpact({ descriptor, operations: ['destroy'], members, held }), /An operation is one of/);
});
