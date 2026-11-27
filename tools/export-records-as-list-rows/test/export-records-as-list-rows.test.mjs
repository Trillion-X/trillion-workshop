// Runs the Python tests of this tool (test/test_list_rows.py) on a made-up toy library: every transform, every kind of source, the
// duplicate-id policies and what an export writes. Needs python3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const here = fileURLToPath(new URL('.', import.meta.url));
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });

test('the Python tests of export-records-as-list-rows pass', { skip: python.status === 0 ? false : 'needs python3' }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});

// Read the descriptor shipped to the actual installed-model consumer, not the native test fixture's model.
test('the published list rule exposes field choices and lifecycle moves to the installed record model', async () => {
  const rows = JSON.parse(await readFile(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
  const rules = rows.records.flatMap(row => row.payload?.record_model?.declared_by ?? []);
  const list = rules.find(rule => rule.type === 'list');
  assert.ok(list, 'the published tool owns the actual list declaration');
  assert.deepEqual(list.properties.choices, ['choices']);
  assert.deepEqual(list.properties.moves, ['moves'], 'without this mapping native field transitions are silently unrestricted');
});
