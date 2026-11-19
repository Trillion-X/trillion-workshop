// test-helpers/write-package-files.mjs
//
// Purpose: writes package-files.json at the Workshop's top folder: for every tool row, the files its run is laid out with
// (test-helpers/tool-row-imports.mjs `packageFilesByRow`): the row's own declared invoke.files.package_files, then a package item for
// every file its entry programs reach through a relative import that the row does not declare, then the npm packages its bare
// imports need. The engine reads this file from an installed copy (trillion-rust src/tool_runs/tools/catalog.rs
// `apply_package_files`, tool-runs.json `package_files_file`) and lays each row out with it, so a row never starts without a
// module it imports: the hand-kept lists missed 6,471 files across 615 rows on Nov 19 2026, and every function tool that ran
// tools/workflows/do-work/run-a-function.mjs, tool:run-workflow-definition among them, stopped with ERR_MODULE_NOT_FOUND.
//
//   node test-helpers/write-package-files.mjs            writes package-files.json from HEAD
//   node test-helpers/write-package-files.mjs --check    exits 1 when the file is not what HEAD makes (test/package-files.test.mjs)
//
// The walk reads git objects at HEAD, so the file is made from a commit: commit the code change, run this, commit the file.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageFilesByRow, refusedModules } from './tool-row-imports.mjs';

export const PACKAGE_FILES = 'package-files.json';

export function packageFilesText({ repo, ref = 'HEAD' }) {
  const byRow = packageFilesByRow({ repo, ref });
  const sorted = Object.fromEntries(Object.keys(byRow).sort().map(id => [id, byRow[id]]));
  return `${JSON.stringify(sorted, null, 1)}\n`;
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const repo = resolve(import.meta.dirname, '..');
  // A module a row imports that its lockfile tree cannot make is left out of the row: say so, never silently.
  for (const line of refusedModules({ repo })) console.error(`REFUSED module, row runs without it: ${line}`);
  const made = packageFilesText({ repo });
  const file = join(repo, PACKAGE_FILES);
  if (process.argv.includes('--check')) {
    let kept = null;
    try { kept = readFileSync(file, 'utf8'); } catch { /* no file yet */ }
    if (kept !== made) { console.error(`${PACKAGE_FILES} is not what HEAD makes: run node test-helpers/write-package-files.mjs and commit it.`); process.exit(1); }
  } else {
    writeFileSync(file, made);
    console.log(JSON.stringify({ wrote: PACKAGE_FILES, rows: Object.keys(JSON.parse(made)).length, bytes: Buffer.byteLength(made) }));
  }
}
