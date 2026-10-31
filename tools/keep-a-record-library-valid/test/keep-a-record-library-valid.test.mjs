// Runs the Python tests of this tool (test/test_keep_a_record_library.py) on a made-up greenhouse library: every kind of check passing and
// failing, the investigation record, the findings library and the derived-file commands. Needs python3; the evidence tests also need
// BLAKE3 (the blake3 python module or the b3sum command) and skip, saying why, without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });

test('the Python tests of keep-a-record-library-valid pass', { skip: python.status === 0 ? false : 'needs python3' }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
