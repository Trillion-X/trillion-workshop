// Runs every Python test file in test/python (test_*.py) as its own node test, through test/python/run_tests.py,
// so a failing Python test fails `npm test` and is named.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('./python/', import.meta.url));

for (const file of readdirSync(folder).filter(name => /^test_.*\.py$/.test(name)).sort()) {
  test(`python ${file}`, () => {
    const run = spawnSync('python3', ['run_tests.py', file], { cwd: folder, encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, / [1-9]\d* passed, 0 failed/);
  });
}
