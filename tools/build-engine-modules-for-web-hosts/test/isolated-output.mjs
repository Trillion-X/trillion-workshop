// Every test that builds or publishes a module writes into a folder of its own. This points the tool's output root
// (build/output-root.mjs) at a mkdtemp folder that starts as a copy of the committed generation, and removes that folder
// when the test file's tests are done. The checkout's built-stored-bytes/ and target/ are then only read by the tests.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { BUILD_TOOL, OUTPUT_ROOT_VARIABLE } from '../build/output-root.mjs';

/** Point this test file's output root at a new folder; returns the folder. Call it at the top of the test file. */
export function isolateOutput() {
  const root = mkdtempSync(join(tmpdir(), 'build-engine-modules-out-'));
  cpSync(join(BUILD_TOOL, 'built-stored-bytes'), join(root, 'built-stored-bytes'), { recursive: true });
  const inherited = process.env[OUTPUT_ROOT_VARIABLE];
  process.env[OUTPUT_ROOT_VARIABLE] = root;
  after(() => {
    if (inherited === undefined) delete process.env[OUTPUT_ROOT_VARIABLE];
    else process.env[OUTPUT_ROOT_VARIABLE] = inherited;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
