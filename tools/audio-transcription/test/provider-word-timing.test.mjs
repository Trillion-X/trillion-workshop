import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('whisper.cpp word bounds reach transcript records and the command requests word timestamps', () => {
  const ran = spawnSync('python3', ['-I', '-B', fileURLToPath(new URL('./test_provider_word_timing.py', import.meta.url))], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
});
