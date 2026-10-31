// Runs test_meaning_index.py: the index, the search and the line protocol on synthetic vectors, then the real CLIP and
// sentence models when they are in the local Hugging Face cache. Skips, saying why, when python3 or numpy is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const here = import.meta.dirname;
const numpy = spawnSync('python3', ['-I', '-m', 'pip', 'show', 'numpy'], { encoding: 'utf8' });
const ready = numpy.status === 0;

test('rows are ranked one per recording, kept values come back in, replies say what to change', { skip: !ready && 'python3 with numpy is needed', timeout: 900000 }, () => {
  const done = spawnSync('python3', ['-B', join(here, 'test_meaning_index.py')], { encoding: 'utf8', timeout: 900000 });
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stderr, /\nOK\b/);
});
