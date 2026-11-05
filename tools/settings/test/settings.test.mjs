// tools/settings: the one settings reader, on made-up rows in a stand-in records door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { settingId, parseSettingId, checkSettingValue, readSetting, settingsFor, layOver, SettingsError } from '../read-data/settings.mjs';
import { runWithSettings } from '../do-work/run-with-settings.mjs';

const ID = 'record:setting:sample-tool~film~sample-film';
const ROW = { name: 'sample-tool for sample-film', tool: 'tool:sample', scope_kind: 'film', scope_id: 'sample-film', settings: { fps: 30, colours: { ink: '#111111', paper: '#ffffff' } }, from: 'films/sample-film/tools/sample.py@0000000000', status: 'active' };
const RIGHTS = [{ kind: 'record:setting', prefix: 'record:setting:sample-tool~', operations: ['records:read'] }];

async function withDoor(records, fn) {
  const fake = await startFakeDoor({ rights: RIGHTS, records });
  try { return await fn(openRecordsDoor({ descriptor: fake.descriptor }), fake); } finally { await fake.close?.(); }
}

test('ids are built and split by folder, scope kind and scope id, and anything else is refused', () => {
  assert.equal(settingId({ folder: 'sample-tool', scope_kind: 'film', scope_id: 'sample-film' }), ID);
  assert.deepEqual(parseSettingId(ID), { folder: 'sample-tool', scope_kind: 'film', scope_id: 'sample-film' });
  for (const bad of ['setting:sample-tool~film~x', 'record:setting:sample-tool~film', 'record:setting:sample-tool~street~x', 'record:setting:Sample~film~x', 'record:setting:a~film~x~y']) {
    assert.throws(() => parseSettingId(bad), SettingsError, bad);
  }
});

test('a row value is checked: every field, a settings object, a matching scope and a known status', () => {
  assert.equal(checkSettingValue(ID, ROW).folder, 'sample-tool');
  const { settings: _s, ...noSettings } = ROW;
  assert.throws(() => checkSettingValue(ID, noSettings), /no settings/);
  assert.throws(() => checkSettingValue(ID, { ...ROW, settings: [1] }), /JSON object/);
  assert.throws(() => checkSettingValue(ID, { ...ROW, scope_id: 'other' }), /do not match/);
  assert.throws(() => checkSettingValue(ID, { ...ROW, status: 'maybe' }), /status/);
});

test('layOver merges plain objects key by key and replaces anything else whole', () => {
  assert.deepEqual(layOver({ a: 1, b: { c: 2, d: 3 }, e: [1, 2] }, { b: { c: 9 }, e: [7] }), { a: 1, b: { c: 9, d: 3 }, e: [7] });
  assert.deepEqual(layOver({ a: 1 }, undefined), { a: 1 });
});

test('readSetting reads the row through the door, null when absent, and refuses another tool\'s row', async () => {
  await withDoor([{ id: ID, type: 'record:setting', value: ROW }], async door => {
    assert.equal((await readSetting(door, ID, { folder: 'sample-tool' })).settings.fps, 30);
    assert.equal(await readSetting(door, 'record:setting:sample-tool~film~absent'), null);
    await assert.rejects(readSetting(door, ID, { folder: 'another-tool' }), /belongs to tools\/sample-tool/);
  });
});

test('settingsFor lays defaults, then the record, then the input\'s own settings', async () => {
  await withDoor([{ id: ID, type: 'record:setting', value: ROW }, { id: 'record:setting:sample-tool~film~old', type: 'record:setting', value: { ...ROW, scope_id: 'old', status: 'retired' } }], async door => {
    const defaults = { fps: 24, colours: { ink: '#000000', accent: '#ff0000' }, width: 1920 };
    const got = await settingsFor({ settings_record: ID, settings: { width: 1080 } }, { door, folder: 'sample-tool', defaults });
    assert.deepEqual(got.settings, { fps: 30, colours: { ink: '#111111', accent: '#ff0000', paper: '#ffffff' }, width: 1080 });
    assert.deepEqual(got.from, { id: ID, from: ROW.from });
    assert.deepEqual((await settingsFor({}, { folder: 'sample-tool', defaults })).settings, defaults);
    await assert.rejects(settingsFor({ settings_record: 'record:setting:sample-tool~film~absent' }, { door, folder: 'sample-tool' }), /Write the row first/);
    await assert.rejects(settingsFor({ settings_record: 'record:setting:sample-tool~film~old' }, { door, folder: 'sample-tool' }), /retired/);
    await assert.rejects(settingsFor({ settings_record: ID }, { folder: 'sample-tool' }), /no records door/);
  });
});

test('run-with-settings hands a Python program the merged settings, and the Python merge matches', async () => {
  await withDoor([{ id: ID, type: 'record:setting', value: ROW }], async door => {
    const echo = fileURLToPath(new URL('./echo_settings.py', import.meta.url));
    let printed = '';
    const out = new Writable({ write(chunk, _e, done) { printed += chunk; done(); } });
    const code = await runWithSettings(['--folder', 'sample-tool', '--', 'python3', '-I', echo], { stdin: Readable.from([JSON.stringify({ settings_record: ID, settings: { width: 1080 }, words: 'hi' })]), door, out });
    assert.equal(code, 0);
    const answer = JSON.parse(printed.trim().split('\n').at(-1));
    assert.deepEqual(answer.settings, { fps: 30, colours: { ink: '#111111', paper: '#ffffff', accent: '#ff0000' }, width: 1080, height: 1080 });
    assert.equal(answer.words, 'hi');
    assert.equal(answer.settings_record, undefined);
    assert.equal(answer.settings_from.id, ID);
  });
});

test('a request with no settings reaches the program unchanged, and the command refuses a missing program', async () => {
  const echo = fileURLToPath(new URL('./echo_settings.py', import.meta.url));
  let printed = '';
  const out = new Writable({ write(chunk, _e, done) { printed += chunk; done(); } });
  await runWithSettings(['--folder', 'sample-tool', '--', 'python3', '-I', echo], { stdin: Readable.from(['{"words":"plain"}']), out });
  assert.equal(JSON.parse(printed.trim()).settings.fps, 24);
  const command = fileURLToPath(new URL('../do-work/run-with-settings.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [command, '--folder', 'sample-tool'], { input: '{}', encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(JSON.parse(run.stdout.trim()).error, /usage/);
});
