// Runs the Python tests of the checklist gate (test/test_checklist_gate.py) on a made-up bakery library: the checklist command, the gate and its
// answers, stale rows, machine-only rows, advisory rows, rebuilds of a pick, scope, audit, the gates' and the checker's own rows, and the sweep.
// Needs python3 and BLAKE3 (the blake3 python module or the b3sum command); without either the run is skipped, saying why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const has = (command, args) => spawnSync(command, args, { encoding: 'utf8' }).status === 0;
const python = has('python3', ['--version']);
const blake3 = python && (has('python3', ['-I', '-m', 'blake3', '--help']) || has('b3sum', ['--version']));
const skip = !python ? 'needs python3' : !blake3 ? 'needs the blake3 python module or the b3sum command' : false;

test('the Python tests of the checklist gate pass', { skip }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_checklist_gate.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
