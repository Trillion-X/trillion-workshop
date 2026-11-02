// Runs this tool's Python tests (test/test_*.py) on made-up channels, videos, captions and thumbnails written by each
// test: admitting a reviewed batch, appending a later one, identity-only, hook and source/status updates with their
// preimages, projecting a source key into template source DATA, and both read-backs. Needs python3 with blake3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const python = spawnSync('python3', ['-I', '-c', 'import blake3'], { encoding: 'utf8' });
const skip = python.error ? 'needs python3' : python.status !== 0 ? 'needs the blake3 Python package (python3 -m pip install blake3)' : false;

test('the Python tests of keep-a-video-packaging-ledger pass', { skip }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
