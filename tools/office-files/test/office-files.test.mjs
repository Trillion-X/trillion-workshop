// tools/office-files: the Python programs' own tests (each is its own program under plain python3, standard library only),
// then the two commands the rows run, over a workbook, a document and a deck this test builds itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const python = (...argv) => spawnSync('python3', ['-I', ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const skip = python('--version').status === 0 ? false : 'needs python3';

for (const file of readdirSync(`${folder}test`).filter(name => /^test_.*\.py$|\.test\.py$/.test(name))) {
  test(`${file} passes`, { skip }, () => {
    const run = python(`${folder}test/${file}`);
    assert.equal(run.status, 0, run.stderr.split('\n').slice(-40).join('\n'));
  });
}

test('the workbook test reports its five cases', { skip }, () => {
  const run = python(`${folder}test/decode-office-open-xml.test.py`);
  assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').at(-1)), { ok: true, cases: 5 });
});
