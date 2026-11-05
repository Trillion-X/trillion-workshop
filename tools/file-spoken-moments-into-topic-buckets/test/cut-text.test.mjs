// Runs test/test_cut_text.py: do-work/cut_text_into_moments.py on a made-up cloud-results copy and store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;

test('untimed transcript text is cut into moments with estimated times and its coverage counted', { skip: !python && 'needs python3' }, () => {
  const out = spawnSync('python3', ['-B', join(folder, 'test', 'test_cut_text.py')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
});
