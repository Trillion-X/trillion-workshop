// test/container-invoke-file-in-package-files.test.mjs
//
// Purpose: a tool row that runs a container program (invoke.kind container) is laid out with the file that program is started
// from. The engine copies a row's laid-out files into the run's folder and starts the program there, so a program file missing
// from the row's package-files.json entry stops every run of that row with "Cannot find module" (tool:sales-contracts and the
// two said-done tools, Nov 20 2026, each lacked its entry).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { PACKAGE_FILES } from '../test-helpers/write-package-files.mjs';
import { toolRowFindings } from '../test-helpers/tool-row-imports.mjs';

const repo = resolve(import.meta.dirname, '..');
const laidOut = JSON.parse(readFileSync(join(repo, PACKAGE_FILES), 'utf8'));
const { results } = toolRowFindings({ repo, ref: 'HEAD' });

// The program files a container row starts: its argv entries that are scripts, as absolute paths in the run's folder.
const programFilesOf = ({ workdir, argv }) => argv
  .filter(arg => typeof arg === 'string' && /\.(mjs|js|cjs)$/.test(arg))
  .map(arg => (arg.startsWith('/') ? arg : posix.join(workdir, arg)));

test('every container tool row is laid out with the program file it starts', () => {
  const containers = results.filter(row => row.kind === 'container' && typeof row.workdir === 'string');
  assert.ok(containers.length > 0, 'the tree has container tool rows to check');
  const missing = [];
  for (const row of containers) {
    const entry = laidOut[row.id] ?? [];
    for (const file of programFilesOf(row)) {
      // An item lays its paths under its `at` folder, so the program file is covered when one of them is its folder or a parent.
      const covered = entry.some(item => (item.paths ?? []).some(path => {
        const laid = posix.join(item.at, path);
        return file === laid || file.startsWith(`${laid}/`);
      }));
      if (!covered) missing.push(`${row.id}: ${file} is not in its ${PACKAGE_FILES} entry`);
    }
  }
  assert.deepEqual(missing, []);
});
