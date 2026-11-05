// The shared settings reader on made-up setting rows and an in-memory door; the Python twin answers the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSettings, settingId, parseSettingId, settingsOf, settingRow, settingRight, SettingError } from '../read-data/settings.mjs';

const ID = 'record:setting:sample-tool~film~kitchen-short';
const row = (value = {}) => ({ name: 'sample', tool: 'sample-tool', scope_kind: 'film', scope_id: 'kitchen-short', settings: { speed: 1.25, voice: 'calm' }, from: 'tools/sample/x.json@abc123', status: 'active', ...value });
const doorOf = records => {
  const reads = [];
  return { reads, read: async (type, id) => { reads.push([type, id]); const hit = records.find(one => one.id === id && one.type === type); return hit ? structuredClone(hit.value) : null; } };
};
const refused = async (promise, code) => { await assert.rejects(promise, error => error instanceof SettingError && error.code === code); };

test('a setting id names its tool, scope kind and scope id, and is read back the same', () => {
  assert.equal(settingId({ tool: 'sample-tool', scope_kind: 'film', scope_id: 'kitchen-short' }), ID);
  assert.deepEqual(parseSettingId(ID), { tool: 'sample-tool', scope_kind: 'film', scope_id: 'kitchen-short' });
  for (const bad of ['setting:x~film~y', 'record:setting:x~film', 'record:setting:x~film~y~z', 'record:setting:x~planet~y', 'record:setting:a/b~film~y', null]) {
    assert.throws(() => parseSettingId(bad), SettingError, String(bad));
  }
  assert.throws(() => settingId({ tool: 'a~b', scope_kind: 'film', scope_id: 'y' }), /must be text without/);
});

test('readSettings reads exactly one record of type record:setting and answers its settings object', async () => {
  const door = doorOf([{ id: ID, type: 'record:setting', value: row() }]);
  assert.deepEqual(await readSettings(door, ID, { tool: 'sample-tool' }), { speed: 1.25, voice: 'calm' });
  assert.deepEqual(door.reads, [['record:setting', ID]]);
});

test('settings kept as JSON text are parsed; anything but an object is refused', async () => {
  assert.deepEqual(await readSettings(doorOf([{ id: ID, type: 'record:setting', value: row({ settings: '{"a":1}' }) }]), ID), { a: 1 });
  for (const settings of ['[1]', 'not json', [1], 3, null]) {
    await refused(readSettings(doorOf([{ id: ID, type: 'record:setting', value: row({ settings }) }]), ID), 'bad_settings');
  }
});

test('refusals: missing, inactive, another tool, a value naming another tool, no door', async () => {
  await refused(readSettings(doorOf([]), ID, { tool: 'sample-tool' }), 'missing');
  await refused(readSettings(doorOf([{ id: ID, type: 'record:setting', value: row({ status: 'retired' }) }]), ID), 'not_active');
  await refused(readSettings(doorOf([{ id: ID, type: 'record:setting', value: row() }]), ID, { tool: 'other-tool' }), 'other_tool');
  await refused(readSettings(doorOf([{ id: ID, type: 'record:setting', value: row({ tool: 'other-tool' }) }]), ID), 'value_tool');
  await refused(readSettings(null, ID), 'no_door');
  await assert.rejects(readSettings(doorOf([]), ID), /Add it as a row of list:settings/);
});

test('a setting row for a loader payload, and the one-record right a row declares', () => {
  const made = settingRow({ tool: 'sample-tool', scope_kind: 'film', scope_id: 'kitchen-short', settings: { speed: 1.25, voice: 'calm' }, name: 'sample', from: 'tools/sample/x.json@abc123' });
  assert.deepEqual(made, { id: ID, type: 'record:setting', value: row() });
  assert.deepEqual(settingsOf(made.value, made.id), { speed: 1.25, voice: 'calm' });
  assert.deepEqual(settingRight(ID), { kind: 'record:setting', id: ID, operations: ['records:read'] });
});

test('the Python twin reads the same rows and refuses the same way', () => {
  const script = fileURLToPath(new URL('./settings_twin.py', import.meta.url));
  const run = spawnSync('python3', ['-I', script], { encoding: 'utf8', input: JSON.stringify({ id: ID, value: row() }) });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').at(-1)), {
    settings: { speed: 1.25, voice: 'calm' },
    row: { id: ID, type: 'record:setting', value: row() },
    refusals: { missing: 'missing', not_active: 'not_active', other_tool: 'other_tool', bad_id: 'bad_id', bad_settings: 'bad_settings' },
  });
});
