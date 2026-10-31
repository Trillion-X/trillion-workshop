// Runs the Python tests of this tool (test/test_list_rows.py) on a made-up toy library: every transform, every kind of source, the
// duplicate-id policies and what an export writes. Needs python3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });

test('the Python tests of export-records-as-list-rows pass', { skip: python.status === 0 ? false : 'needs python3' }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
