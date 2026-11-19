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
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { layoutDuplicates, packageFilesByRow, refusedModules } from './tool-row-imports.mjs';

export const PACKAGE_FILES = 'package-files.json';

// The file is made from a tree that holds the newest origin/main. A tree older than it regenerates the file from old code and
// drops what the newer main added (the 2026-11-19 regenerations dropped 68 WhatsApp packages and 58 rows that way). A checkout
// is judged by its HEAD after a fetch of origin; an export (no .git) names the commit it was made from in BASE, and MAIN_REPO
// names the checkout whose origin/main that commit must hold. Returns a plain reason when the tree is older, else null.
export function olderThanMain({ repo, env = process.env }) {
  const git = (folder, args) => execFileSync('git', ['-C', folder, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 ** 20 }).toString().trim();
  const isCheckout = !env.BASE && (() => { try { return realpathSync(git(repo, ['rev-parse', '--show-toplevel'])) === realpathSync(repo); } catch { return false; } })();
  if (!isCheckout && !env.BASE) return 'this tree is an export: set BASE to the commit it was made from, and MAIN_REPO to the checkout that holds origin/main.';
  const checkout = isCheckout ? repo : env.MAIN_REPO;
  if (!checkout) return 'set MAIN_REPO to the checkout that holds origin/main, so the export can be judged against it.';
  git(checkout, ['fetch', '-q', 'origin']);
  const main = git(checkout, ['rev-parse', 'origin/main']);
  const tree = isCheckout ? git(checkout, ['rev-parse', 'HEAD']) : env.BASE;
  try { git(checkout, ['merge-base', '--is-ancestor', main, tree]); } catch { return `the tree at ${tree.slice(0, 10)} is older than origin/main at ${main.slice(0, 10)}: fetch, rebuild the tree from origin/main, then regenerate.`; }
  return null;
}

export function packageFilesText({ repo, ref = 'HEAD' }) {
  const byRow = packageFilesByRow({ repo, ref });
  // A row that lays the same thing twice is refused: the engine refuses that row's every run (layoutDuplicates).
  const doubled = Object.entries(byRow).flatMap(([id, items]) => layoutDuplicates(items).map(key => `${id}: ${key}`));
  if (doubled.length) throw new Error(`a row lays the same thing twice, and the engine refuses every run of it:\n${doubled.join('\n')}`);
  const sorted = Object.fromEntries(Object.keys(byRow).sort().map(id => [id, byRow[id]]));
  return `${JSON.stringify(sorted, null, 1)}\n`;
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const repo = resolve(import.meta.dirname, '..');
  // Writing is refused from a tree older than origin/main (a check reads no file it would write).
  if (!process.argv.includes('--check')) {
    const older = olderThanMain({ repo });
    if (older) { console.error(`NOT WRITTEN: ${older}`); process.exit(1); }
  }
  // A module a row imports that its lockfile tree cannot make is left out of the row: say so, never silently.
  for (const line of refusedModules({ repo })) console.error(`REFUSED module, row runs without it: ${line}`);
  const file = join(repo, PACKAGE_FILES);
  const made = packageFilesText({ repo });
  if (process.argv.includes('--check')) {
    let kept = null;
    try { kept = readFileSync(file, 'utf8'); } catch { /* no file yet */ }
    if (kept !== made) { console.error(`${PACKAGE_FILES} is not what HEAD makes: run node test-helpers/write-package-files.mjs and commit it.`); process.exit(1); }
  } else {
    writeFileSync(file, made);
    console.log(JSON.stringify({ wrote: PACKAGE_FILES, rows: Object.keys(JSON.parse(made)).length, bytes: Buffer.byteLength(made) }));
  }
}
