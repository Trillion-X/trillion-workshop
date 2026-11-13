// Runs the Python tests of this tool (test/test_*.py): the trainer's and scorer's DATA, provenance and receipt checks,
// the section-chunk packer and the exposure audit, on made-up rows with stand-ins for the decider model frame
// (test/stand_in_decider.py). Needs python3 and its blake3 module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });

test('the Python tests of train-and-evaluate-a-writing-voice-classifier pass', { skip: python.status === 0 ? false : 'needs python3', timeout: 120000 }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
  assert.match(run.stderr, /Ran 87 tests/);
});
