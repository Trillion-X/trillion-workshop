// tools/headless-browser: removing the throwaway profile never fails the caller's run. A folder that cannot be removed
// yet (a helper process of the killed browser still writing it: ENOTEMPTY) is removed again a moment later.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeProfile } from '../devtools.mjs';

test('a profile that can be removed is removed at once', () => {
  const folder = mkdtempSync(join(tmpdir(), 'profile-cleanup-'));
  writeFileSync(join(folder, 'Cookies'), 'x');
  removeProfile(folder);
  assert.equal(existsSync(folder), false);
});

test('a profile still being written does not throw, and is removed once more a moment later', async () => {
  const tried = [];
  const remove = folder => {
    tried.push(folder);
    if (tried.length === 1) throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${folder}/Default'`), { code: 'ENOTEMPTY' });
  };
  assert.doesNotThrow(() => removeProfile('/tmp/headless-browser-test', { remove, laterMs: 20 }));
  assert.equal(tried.length, 1);
  await new Promise(done => setTimeout(done, 60));
  assert.deepEqual(tried, ['/tmp/headless-browser-test', '/tmp/headless-browser-test']);
});
