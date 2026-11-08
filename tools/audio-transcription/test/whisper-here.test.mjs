// Runs test/test_whisper_here.py (the engine chooser do-work/whisper_here.py) in `npm test`. Every engine there is a
// stand-in module, so it needs python3 alone and no Whisper installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;

test('whisper_here picks the engine the computer has and answers in mlx_whisper\'s shape', { skip: !python && 'needs python3' }, () => {
  const out = spawnSync('python3', ['-B', join(folder, 'test', 'test_whisper_here.py'), '-v'], { encoding: 'utf8', cwd: folder });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /Ran 9 tests/);
});
