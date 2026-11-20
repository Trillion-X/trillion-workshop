// The other tests of this tool write only into folders of their own (test/isolated-output.mjs), never into the checkout.
// This runs them as child processes, each with the checkout as it is, and asserts that the tool's folder has the same
// content before and after: a BLAKE3 identity over the path and bytes of every file under it. Modification times are not
// part of the identity, because cargo's freshness step (build/shared-cargo-target.mjs) sets the times of crate sources.
// The children are not required to pass here; their own tests say that. This test requires that they ran (their TAP
// summary names a test count) and that nothing under the tool's folder changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { OUTPUT_ROOT_VARIABLE } from '../build/output-root.mjs';

const TOOL = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const OTHER_TESTS = readdirSync(join(TOOL, 'test'))
  .filter(name => name.endsWith('.test.mjs'))
  .map(name => join(TOOL, 'test', name))
  .filter(path => path !== SELF)
  .sort();

/** One BLAKE3 identity over the relative path and bytes of every file under `root`. */
function contentIdentity(root) {
  const lines = [];
  const walk = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) lines.push(`${relative(root, path)}\0${bytesToHex(blake3(readFileSync(path)))}`);
      else throw new Error(`${path} is neither a file nor a folder`);
    }
  };
  walk(root);
  return bytesToHex(blake3(new TextEncoder().encode(lines.sort().join('\n'))));
}

test('the other tests of this tool leave its folder unchanged: they write only into their own folders', { timeout: 1_800_000 }, () => {
  const before = contentIdentity(TOOL);
  // Each test file isolates its own output root; the variable is removed here so none of them inherits another's.
  const env = { ...process.env };
  delete env[OUTPUT_ROOT_VARIABLE];
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...OTHER_TESTS], { cwd: TOOL, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const count = /^# tests (\d+)$/m.exec(run.stdout ?? '');
  assert.ok(count && Number(count[1]) > 0, `the child suite did not run any tests:\n${(run.stdout ?? '').slice(-2000)}${run.stderr ?? ''}`.slice(0, 4000));
  assert.equal(contentIdentity(TOOL), before, 'a test changed the checkout of this tool; a test must write only into its own folder');
});
