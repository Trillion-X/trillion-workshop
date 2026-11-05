// tools/settings: the settings row id, the old setting store over a snapshot, settingsOf's refusals, readSettings
// through a stand-in door, and the command the Python tools run. All values are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecordId, readSettings, readSettingsRow, recordId, settingStore, settingsOf, snapshotEeaf } from '../read-data/settings-record.mjs';

const module = fileURLToPath(new URL('../read-data/settings-record.mjs', import.meta.url));
const row = (over = {}) => ({
  id: 'record:setting:make-a-sample-sound~film~sample-film',
  type: 'record:setting',
  value: { name: 'Sample', tool: 'tool:make-a-sample-sound', scope_kind: 'film', scope_id: 'sample-film', settings: { gain_db: 3, words: ['a', 'b'] }, from: 'made-up/settings.json@0000000', status: 'active', ...over },
});

test('a settings id names the folder, the scope kind and the scope, and reads back', () => {
  const id = recordId({ folder: 'make-a-sample-sound', scope_kind: 'person', scope_id: 'me' });
  assert.equal(id, 'record:setting:make-a-sample-sound~person~me');
  assert.deepEqual(parseRecordId(id), { folder: 'make-a-sample-sound', scope_kind: 'person', scope_id: 'me' });
  assert.throws(() => recordId({ folder: 'make-a-sample-sound', scope_kind: 'team', scope_id: 'me' }), /scope_kind is one of person, film, piece, account/);
  assert.throws(() => recordId({ folder: 'Has Spaces', scope_kind: 'person', scope_id: 'me' }), /Workshop folder name/);
  assert.throws(() => parseRecordId('list:tool-settings:x'), /record:setting:<workshop-folder>~<scope_kind>~<scope_id>/);
  assert.throws(() => parseRecordId('record:setting:a~person'), /record:setting:/);
});

test('the old setting store reads, lists and writes settings as it did', () => {
  const other = { ...row({ scope_id: 'other' }), id: 'record:setting:make-a-sample-sound~film~other' };
  const eeaf = snapshotEeaf([row(), other]);
  const store = settingStore(eeaf);
  assert.equal(store.setting('make-a-sample-sound~film~sample-film').settings.gain_db, 3);
  assert.equal(store.setting('missing~person~me'), null);
  assert.deepEqual(store.settings('make-a-sample-sound~film~').map(one => one.name), ['make-a-sample-sound~film~other', 'make-a-sample-sound~film~sample-film']);
  assert.deepEqual(store.settings('nothing'), []);
  const value = { ...row().value, settings: { gain_db: 4 } };
  assert.equal(store.setSetting('make-a-sample-sound~film~sample-film', value), value);
  assert.equal(store.setting('make-a-sample-sound~film~sample-film').settings.gain_db, 4);
  assert.deepEqual(eeaf.writes, [{ id: 'record:setting:make-a-sample-sound~film~sample-film', type: 'record:setting', value }]);
  store.setSetting('make-a-sample-sound~film~other', null);
  assert.equal(store.setting('make-a-sample-sound~film~other'), null);
  assert.equal(eeaf.writes.at(-1).value, null);
  assert.throws(() => snapshotEeaf([{ id: 'list:tool-settings:x', type: 'record:list-row', value: {} }]), /Only record:setting records are settings/);
});

test('settingsOf gives the settings and refuses what is not this tool\'s live row', () => {
  assert.deepEqual(settingsOf(row(), 'make-a-sample-sound'), { gain_db: 3, words: ['a', 'b'] });
  assert.deepEqual(settingsOf(row()), { gain_db: 3, words: ['a', 'b'] });
  assert.deepEqual(settingsOf(row({ settings: '{"gain_db":3}' })), { gain_db: 3 });
  assert.throws(() => settingsOf(row({ settings: '{not json' })), /settings text is not JSON/);
  assert.throws(() => settingsOf(row(), 'another-tool'), /settings of tools\/make-a-sample-sound, not tools\/another-tool/);
  assert.throws(() => settingsOf(row({ status: 'retired' })), /is retired/);
  assert.throws(() => settingsOf(row({ settings: [1] })), /has no settings object/);
  assert.throws(() => settingsOf(row({ scope_id: 'else' })), /says scope_id else but its id says sample-film/);
  assert.throws(() => settingsOf({ ...row(), value: null }), /is not in the person's list:settings/);
  assert.throws(() => settingsOf(null), /settings_record names no record/);
});

test('readSettings reads one row through the door', async () => {
  const asked = [];
  const door = { read: async (type, id) => { asked.push([type, id]); return id === row().id ? row().value : null; } };
  assert.deepEqual(await readSettings(door, row().id, 'make-a-sample-sound'), { gain_db: 3, words: ['a', 'b'] });
  assert.deepEqual(asked, [['record:setting', row().id]]);
  await assert.rejects(readSettings(door, 'record:setting:make-a-sample-sound~person~nobody'), /is not in the person's list:settings/);
  assert.deepEqual(await readSettingsRow({ settings_record: row().id }, { door }), { id: row().id, folder: 'make-a-sample-sound', scope_kind: 'film', scope_id: 'sample-film', settings: { gain_db: 3, words: ['a', 'b'] } });
});

test('the command prints the settings of a record file, and refuses another folder\'s', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'settings-')), 'record.json');
  writeFileSync(file, JSON.stringify(row()));
  const ok = spawnSync(process.execPath, [module, 'settings-of', '--record', file, '--folder', 'make-a-sample-sound'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { gain_db: 3, words: ['a', 'b'] });
  const no = spawnSync(process.execPath, [module, 'settings-of', '--record', file, '--folder', 'another-tool'], { encoding: 'utf8' });
  assert.equal(no.status, 2);
  assert.match(no.stderr, /not tools\/another-tool/);
  const usage = spawnSync(process.execPath, [module], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: node settings-record.mjs settings-of/);
});
