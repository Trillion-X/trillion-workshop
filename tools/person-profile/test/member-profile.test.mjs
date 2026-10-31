// tool:read-a-member-profile and tool:save-a-member-profile run as the container runs them, against the fake records
// door with exactly the rows' rights. Carries the three cases of packages/person-profile/do-work/save-member-profile.test.ts
// (a save keeps what the record already holds, a missing profile is not invented, a failed write is not a saved
// profile); the browser cache the old test also checked belongs to the screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const read = rowOf(rows, 'tool:read-a-member-profile');
const save = rowOf(rows, 'tool:save-a-member-profile');
const held = { id: 'member-profile:account:sample', type: 'member-profile', value: { kind: 'person-profile.member-profile/v1', actor_ref: 'account:sample', role: 'Creator', display_name: 'Old', about: '', email: 'old@example.test' } };

test('a save changes the fields given and keeps the rest of the record', async () => {
  const ran = await runRow(save, { who: 'account:sample', fields: { display_name: ' Sam Example ', about: 'Makes videos' } }, { records: [held] });
  assert.equal(ran.status, 0, ran.error);
  assert.deepEqual(ran.result, { saved: true, profile: { display_name: 'Sam Example', about: 'Makes videos', email: 'old@example.test' } });
  const kept = ran.kept.find(record => record.id === held.id).value;
  assert.equal(kept.role, 'Creator');
  assert.equal(kept.email, 'old@example.test');
  assert.match(kept.updated_at, /^\d{4}-\d\d-\d\dT/);
});

test('a first save makes the record, and an empty value is saved as empty', async () => {
  const ran = await runRow(save, { who: 'local:new', fields: { about: '' } });
  assert.equal(ran.status, 0, ran.error);
  assert.deepEqual(ran.kept.map(record => [record.id, record.type, record.value.actor_ref, record.value.display_name]), [['member-profile:local:new', 'member-profile', 'local:new', '']]);
});

test('reading a member with no profile answers null instead of inventing fields', async () => {
  const ran = await runRow(read, { who: 'local:none' });
  assert.equal(ran.status, 0, ran.error);
  assert.deepEqual(ran.result, { profile: null });
});

test('a profile is read back without the rest of the record', async () => {
  const ran = await runRow(read, { who: 'account:sample' }, { records: [held] });
  assert.deepEqual(ran.result, { profile: { display_name: 'Old', about: '', email: 'old@example.test' } });
});

test('a write the door refuses is not a saved profile', async () => {
  const readOnly = { ...save, invoke: { ...save.invoke, records: { fd: 3, rights: [{ kind: 'member-profile', operations: ['records:read'] }] } } };
  const ran = await runRow(readOnly, { who: 'local:one', fields: { display_name: 'Sam Example' } });
  assert.equal(ran.status, 1);
  assert.match(ran.error, /may not reach those records/);
  assert.deepEqual(ran.kept, []);
});

test('a field that is not a profile field, no fields and a bad identity are refused with what to give', async () => {
  assert.match((await runRow(save, { who: 'a', fields: { role: 'Admin' } })).error, /Unknown profile field: role/);
  assert.match((await runRow(save, { who: 'a', fields: {} })).error, /at least one field/);
  assert.match((await runRow(save, { who: '', fields: { about: 'x' } })).error, /identity is unavailable/);
});

test('a stored record that is not a profile of that member is not trusted', async () => {
  const other = { ...held, value: { ...held.value, actor_ref: 'account:other' } };
  assert.match((await runRow(read, { who: 'account:sample' }, { records: [other] })).error, /Saved profile is unavailable/);
});

test('the rows only reach member-profile records, the read row cannot write', () => {
  assert.deepEqual(read.invoke.records.rights, [{ kind: 'member-profile', operations: ['records:read'] }]);
  assert.deepEqual(save.invoke.records.rights, [{ kind: 'member-profile', operations: ['records:read', 'records:write'] }]);
});
