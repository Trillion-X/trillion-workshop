// tools/settings: the settings a tool runs with, read from the rows handed in its input (input.stored.records), on
// made-up rows. No store is reached: the caller reads the rows from the person's store and hands them in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handedRecord, settingsFor, layOver, isSettingId } from '../read-data/settings.mjs';

const ID = 'record:setting:sample-tool~film~sample-film';
const ROW = { name: 'sample-tool for sample-film', tool: 'tool:sample', scope_kind: 'film', scope_id: 'sample-film', settings: '{"colours":{"ink":"#111111","paper":"#ffffff"},"fps":30}', from: 'made-up/sample.py@0000000', status: 'active' };
const STORED = { records: [{ id: ID, type: 'record:setting', value: ROW }, { id: 'note:1', type: 'note', value: { words: 'not a setting' } }] };
const DEFAULTS = { fps: 24, colours: { ink: '#000000', accent: '#ff0000' }, width: 1920 };
const READ_DATA = fileURLToPath(new URL('../read-data', import.meta.url));

test('layOver merges plain objects key by key and replaces anything else whole; ids are told from paths', () => {
  assert.deepEqual(layOver({ a: 1, b: { c: 2, d: 3 }, e: [1, 2] }, { b: { c: 9 }, e: [7] }), { a: 1, b: { c: 9, d: 3 }, e: [7] });
  assert.equal(isSettingId(ID), true);
  assert.equal(isSettingId('/tmp/rows.json'), false);
});

test('handedRecord finds the row among the rows handed in, null when absent, and refuses another tool\'s row', () => {
  assert.deepEqual(handedRecord(STORED, ID, { folder: 'sample-tool' }), { id: ID, type: 'record:setting', value: ROW });
  assert.equal(handedRecord(STORED, 'record:setting:sample-tool~film~absent'), null);
  assert.equal(handedRecord({ records: [{ id: ID, type: 'record:setting', value: null }] }, ID), null);
  assert.throws(() => handedRecord(STORED, ID, { folder: 'another-tool' }), /belongs to tools\/sample-tool/);
});

test('settingsFor lays the defaults, then the row handed in, then the input\'s own settings', () => {
  const got = settingsFor({ settings_record: ID, stored: STORED, settings: { width: 1080 } }, { folder: 'sample-tool', defaults: DEFAULTS });
  assert.deepEqual(got.settings, { fps: 30, colours: { ink: '#111111', accent: '#ff0000', paper: '#ffffff' }, width: 1080 });
  assert.deepEqual(got.from, { id: ID, from: ROW.from });
  const byRows = settingsFor({ stored: STORED }, { folder: 'sample-tool', scopes: [['film', 'sample-film']], defaults: DEFAULTS });
  assert.equal(byRows.settings.fps, 30);
  const handed = settingsFor({ settings_record: { id: ID, type: 'record:setting', value: ROW } }, { folder: 'sample-tool', defaults: DEFAULTS });
  assert.equal(handed.settings.fps, 30);
  assert.deepEqual(settingsFor({}, { defaults: DEFAULTS }), { settings: DEFAULTS, from: null });
  assert.throws(() => settingsFor({ settings: [1] }, {}), /JSON object/);
});

test('a named row is refused when no rows were handed or it is not among them, never run on the defaults', () => {
  assert.throws(() => settingsFor({ settings_record: ID }, { folder: 'sample-tool', defaults: DEFAULTS }), /no rows were handed in/);
  assert.throws(() => settingsFor({ settings_record: 'record:setting:sample-tool~film~absent', stored: STORED }, { folder: 'sample-tool' }), /write the row first/);
  assert.throws(() => settingsFor({ settings_record: ID, stored: { records: [] } }, { folder: 'sample-tool' }), /write the row first/);
  assert.throws(() => settingsFor({ stored: [] }, {}), /stored, when given/);
});

test('request_settings in Python reads the same handed rows the same way', () => {
  const program = [
    'import json, sys', `sys.path.insert(0, ${JSON.stringify(READ_DATA)})`, 'import settings',
    'request = json.loads(sys.stdin.read())',
    'try:',
    `    print(json.dumps({"settings": settings.request_settings(request, ${JSON.stringify(DEFAULTS)}, folder="sample-tool")}))`,
    'except settings.SettingError as exc:',
    '    print(json.dumps({"error": str(exc)}))',
  ].join('\n');
  const run = request => JSON.parse(spawnSync('python3', ['-I', '-c', program], { input: JSON.stringify(request), encoding: 'utf8' }).stdout.trim());
  const js = settingsFor({ settings_record: ID, stored: STORED, settings: { width: 1080 } }, { folder: 'sample-tool', defaults: DEFAULTS }).settings;
  assert.deepEqual(run({ settings_record: ID, stored: STORED, settings: { width: 1080 } }).settings, js);
  assert.match(run({ settings_record: ID }).error, /no rows were handed in/);
  assert.match(run({ settings_record: 'record:setting:sample-tool~film~absent', stored: STORED }).error, /write the row first/);
  assert.equal(run({ words: 'plain' }).settings.fps, 24);
});
