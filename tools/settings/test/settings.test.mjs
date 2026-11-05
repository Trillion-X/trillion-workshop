// The shared settings reader: the Node reader on made-up rows, read through the stand-in records door, and the Python
// reader's tests (test_read_setting.py), which hold the same rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { parseSettingId, readSetting, SettingRefused, settingId, settingOf, settingsOf } from '../read-data/setting.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROW = {
  id: 'record:setting:sort-a-pantry~person~sample-cook',
  type: 'record:setting',
  value: { name: 'pantry sort', tool: 'sort-a-pantry', scope_kind: 'person', scope_id: 'sample-cook', settings: '{"shelves":3}', from: 'tools/pantry/settings.json@0000000', status: 'active' },
};

test('a setting id names the Workshop folder, the scope kind and the scope', () => {
  assert.equal(settingId('sort-a-pantry', 'film', 'kitchen-2026'), 'record:setting:sort-a-pantry~film~kitchen-2026');
  assert.deepEqual(parseSettingId('record:setting:sort-a-pantry~account~main'), { tool: 'sort-a-pantry', scope_kind: 'account', scope_id: 'main' });
  for (const args of [['Sort', 'person', 'a'], ['sort', 'team', 'a'], ['sort', 'person', 'A B']]) assert.throws(() => settingId(...args), SettingRefused);
  for (const id of ['record:check:x', 'record:setting:a~b', 'record:setting:a~person~b~c', 7]) assert.throws(() => parseSettingId(id), SettingRefused);
});

test('a row gives its settings; inline settings serve samples; wrong, absent and retired rows are refused', () => {
  assert.deepEqual(settingsOf({ settings_record: ROW }, 'sort-a-pantry'), { shelves: 3 });
  assert.equal(settingOf(ROW).scope_id, 'sample-cook');
  assert.deepEqual(settingsOf({ settings: { a: 1 } }, 'x'), { a: 1 });
  assert.equal(settingsOf({}, 'x', { required: false }), null);
  assert.throws(() => settingsOf({}, 'x'), /record:setting:x~/);
  assert.throws(() => settingsOf({ settings_record: ROW }, 'other-tool'), /not of other-tool/);
  assert.throws(() => settingOf({ ...ROW, value: null }), /no setting/);
  assert.throws(() => settingOf({ ...ROW, value: { ...ROW.value, status: 'retired' } }), /retired/);
  assert.throws(() => settingOf({ ...ROW, value: { ...ROW.value, scope_id: 'someone-else' } }), /scope_id/);
  assert.throws(() => settingOf({ ...ROW, value: { ...ROW.value, settings: '{nope' } }), /not JSON/);
  assert.throws(() => settingOf({ ...ROW, type: 'record:check' }), /type/);
});

test('readSetting reads the row through the door, and answers value null for a row the person has not written', async () => {
  const door = await startFakeDoor({ rights: [{ kind: 'record:setting', prefix: 'record:setting:sort-a-pantry~', operations: ['records:read'] }], records: [ROW] });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor });
    const read = await readSetting(client, ROW.id);
    assert.deepEqual(settingsOf({ settings_record: read }, 'sort-a-pantry'), { shelves: 3 });
    const absent = await readSetting(client, 'record:setting:sort-a-pantry~film~none');
    assert.equal(absent.value, null);
    assert.throws(() => settingOf(absent), /no setting/);
    await assert.rejects(readSetting(client, 'record:check:not-a-setting'), SettingRefused);
    assert.deepEqual(door.calls.map(call => call.method), ['records:read', 'records:read']);
  } finally { await door.close(); }
});

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
test('the Python reader holds the same rules', { skip: python.status === 0 ? false : 'needs python3' }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
