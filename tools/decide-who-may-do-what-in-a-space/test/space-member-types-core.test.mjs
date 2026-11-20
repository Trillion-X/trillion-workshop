// The member-type graph on read-data/space-member-types-core.mjs: each label offers its own types from DATA, a type inherits
// its parents once each, a cycle or a missing parent fails closed, and a legacy role stays a leaf. Ported from the held
// member-type tests at old tag b6ae0ebf8 (tools/decide-who-may-do-what-in-a-space/from-an-older-version/test/); the
// outcomes that need the retired network write path or the SQL reader are not here (see that folder's README).
import test from 'node:test';
import assert from 'node:assert/strict';
import memberTypes from '../../space-member-types/src/space-member-types.json' with { type: 'json' };
import { inheritedMemberTypes, spaceMemberTypeMethods } from '../read-data/space-member-types-core.mjs';

test('each label offers its own types from DATA, with the owner\'s own rows after them', async () => {
  for (const label of Object.keys(memberTypes.labels)) {
    const graph = { records: { ownMemberTypes: async () => [] } };
    const types = await spaceMemberTypeMethods.baseMemberTypesOf.call(graph, { id: 'space-a', label });
    assert.deepEqual(types.map(type => type.id), memberTypes.labels[label].types.map(type => type.id));
    assert.ok(types.every(type => type.own === false));
  }
});

test('a pursuit-owned type is offered after the label\'s own types, marked as its own', async () => {
  const label = Object.keys(memberTypes.labels)[0];
  const graph = { records: { ownMemberTypes: async () => [{ id: 'own-one', label: 'Own one', inherits: [] }] } };
  const types = await spaceMemberTypeMethods.baseMemberTypesOf.call(graph, { id: 'space-a', label });
  assert.equal(types.at(-1).id, 'own-one');
  assert.equal(types.at(-1).own, true);
});

test('nested types inherit their parents, parent first, each once', () => {
  assert.deepEqual(inheritedMemberTypes([
    { id: 'reader', inherits: [] }, { id: 'editor', inherits: ['reader'] }, { id: 'lead', inherits: ['editor'] },
  ], 'lead'), ['reader', 'editor', 'lead']);
  assert.deepEqual(inheritedMemberTypes([
    { id: 'a', inherits: [] }, { id: 'b', inherits: ['a'] }, { id: 'c', inherits: ['a', 'b'] },
  ], 'c'), ['a', 'b', 'c']);
});

test('a cycle fails closed, and so does a parent that is not in the space', () => {
  assert.throws(() => inheritedMemberTypes([{ id: 'one', inherits: ['two'] }, { id: 'two', inherits: ['one'] }], 'one'), /cycle/);
  assert.throws(() => inheritedMemberTypes([{ id: 'one', inherits: ['missing'] }], 'one'), /not in this space/);
});

test('a legacy role stored on a member stays an exact leaf, with no parents', async () => {
  const graph = { memberTypesOf: async () => [{ id: 'reader', inherits: [] }] };
  assert.deepEqual(await spaceMemberTypeMethods.memberTypeIdsOf.call(graph, { id: 'space-a' }, 'legacy-role'), ['legacy-role']);
});
