import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('a scoped source application runs through the existing checklist gate', () => {
  const script = fileURLToPath(new URL('./test_library_checks.py', import.meta.url));
  const run = spawnSync('python3', ['-I', script], {encoding:'utf8'});
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
