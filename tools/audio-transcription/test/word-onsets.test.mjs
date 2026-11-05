// Runs test/test_word_onsets.py (do-work/word_onsets.py: word starts moved to where the voice starts) in `npm test`.
// It needs python3 with numpy and soundfile; without them the Python tests skip and say so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;

test('word_onsets moves word starts to where the voice starts and keeps the script spelling', { skip: !python && 'needs python3' }, () => {
  const out = spawnSync('python3', ['-B', join(folder, 'test', 'test_word_onsets.py'), '-v'], { encoding: 'utf8', cwd: folder });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /Ran 5 tests/);
});
