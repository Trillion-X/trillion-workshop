import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const preload = join(here, '..', 'test-helpers', 'own-tmpdir.mjs');

test('a test run has its own temp folder and what a test leaves in it goes when the run ends', () => {
  const printed = execFileSync(process.execPath, ['--import', preload, '-e',
    "import('node:fs').then(fs => { fs.mkdirSync(process.env.TMPDIR + '/left-behind'); console.log(process.env.TMPDIR); });"],
  { encoding: 'utf8' }).trim();
  assert.notEqual(printed, realpathSync(tmpdir()), 'a folder of its own, not the shared temp folder');
  assert.equal(dirname(printed), realpathSync(tmpdir()));
  assert.equal(existsSync(printed), false, 'removed with everything a test left in it');
});
