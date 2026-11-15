import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('the source scanner preserves its patterns, formats, and missing-input filtering', () => {
  const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./test_list_inputs.py', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 4 tests/);
});
