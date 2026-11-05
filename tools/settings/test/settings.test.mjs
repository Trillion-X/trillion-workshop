// The Python reader's tests under npm test, and the JavaScript reader on the same made-up rows: both give the same answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRecord, parseId, setting, settingId, SettingError } from '../read-data/settings.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));

test('the Python reader passes its tests', () => {
  const done = spawnSync('python3', ['-I', join(folder, 'test', 'test_settings.py')], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
});

test('the JavaScript reader picks the most specific scope and gives the default when there is none', () => {
  const make = (kind, scope, values, status) => makeRecord('make-a-sample', kind, scope, values, { name: 'sample', tool: 'tool:make-a-sample', source: 'x@0', status });
  const rows = [make('account', 'main', { pace: 1 }), make('film', 'f1', { pace: 2 })];
  assert.equal(settingId('make-a-sample', 'film', 'a~b'), 'record:setting:make-a-sample~film~a~b');
  assert.deepEqual(parseId('record:setting:make-a-sample~film~a~b'), ['make-a-sample', 'film', 'a~b']);
  assert.deepEqual(setting(rows, { folder: 'make-a-sample', scopes: [['film', 'f1'], ['account', 'main']] }), { pace: 2 });
  assert.deepEqual(setting(rows, { folder: 'make-a-sample', scopes: [['film', 'f9'], ['account', 'main']] }), { pace: 1 });
  assert.equal(setting(rows, { folder: 'make-a-sample', scopes: [['film', 'f9']] }), null);
  assert.deepEqual(setting(null, { fallback: { pace: 0 } }), { pace: 0 });
  assert.throws(() => setting(rows, { folder: 'make-a-sample' }), SettingError);
  assert.throws(() => setting(make('film', 'f', {}, 'retired')), SettingError);
  assert.throws(() => setting(rows[0], { tool: 'tool:another' }), SettingError);
  assert.equal(rows[1].value.settings, '{"pace":2}');
});

test('the row runs the command that exists', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
  assert.equal(row.id, 'tool:read-a-tool-setting');
  assert.ok(existsSync(join(folder, 'do-work', 'read_setting.py')));
});
