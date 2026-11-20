// test-helpers/temp-folder.mjs
//
// A temp folder a test makes and removes when its file's tests are done, failed or not. The argument is the mkdtemp prefix
// path a test would give mkdtemp (for example join(tmpdir(), 'name-')). Only the test process removes what it made: a child
// process a test starts makes folders its parent reads after the child exits, so it does not remove them.
import { mkdtempSync, rmSync } from 'node:fs';
import { after } from 'node:test';

const made = new Set();
after(() => {
  for (const folder of made) rmSync(folder, { recursive: true, force: true });
  made.clear();
});

export function tempFolder(prefixPath) {
  const folder = mkdtempSync(prefixPath);
  made.add(folder);
  return folder;
}
