// package-files.json is what test-helpers/write-package-files.mjs makes from this tree: every tool row's laid-out files, the
// row's declared package_files plus every file its programs reach. The engine lays rows out with it, so a stale file starts a
// row without a module it imports.
import { tempFolder } from '../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PACKAGE_FILES, packageFilesText } from '../test-helpers/write-package-files.mjs';
import { duplicateLayouts } from '../tools/workflows/do-work/pin-a-commit-by-its-files.mjs';

const repo = resolve(import.meta.dirname, '..');

test('package-files.json is the laid-out files every tool row needs, made from this tree', () => {
  const env = {};
  let ref = 'HEAD';
  if (!existsSync(join(repo, '.git'))) {
    const gitDir = tempFolder(join(tmpdir(), 'package-files-git-'));
    Object.assign(env, { GIT_DIR: gitDir, GIT_WORK_TREE: repo, GIT_INDEX_FILE: join(gitDir, 'index'), GIT_AUTHOR_NAME: 'check', GIT_AUTHOR_EMAIL: 'check@example.test', GIT_COMMITTER_NAME: 'check', GIT_COMMITTER_EMAIL: 'check@example.test' });
    const git = args => execFileSync('git', args, { env: { ...process.env, ...env }, maxBuffer: 2 ** 30 }).toString().trim();
    git(['init', '-q']); git(['add', '-A', '-f', '.']);
    ref = git(['commit-tree', git(['write-tree']), '-m', 'check tree']);
  }
  const saved = { ...process.env };
  Object.assign(process.env, env);
  let made;
  try { made = packageFilesText({ repo, ref }); } finally { for (const key of Object.keys(env)) { if (key in saved) process.env[key] = saved[key]; else delete process.env[key]; } }
  assert.equal(readFileSync(join(repo, PACKAGE_FILES), 'utf8'), made, `${PACKAGE_FILES} is stale: run node test-helpers/write-package-files.mjs and commit it.`);
  const rows = JSON.parse(made);
  assert.ok(rows['tool:run-workflow-definition'].some(item => item.package === 'decide-with-a-method' && item.paths.includes('read-data/decision-outcome.mjs')), 'the workflow runner is laid out with the decision outcome module its kit check imports');
});

test('every file a tool row is laid out with is in this tree', () => {
  // The engine copies each laid-out path into the run's folder and refuses the whole run when one is missing (NotRunnableHere),
  // so a moved or removed file named here stops every run of that row, and every workflow when the row is the workflow runner.
  const rows = JSON.parse(readFileSync(join(repo, PACKAGE_FILES), 'utf8'));
  const missing = [];
  for (const [row, items] of Object.entries(rows)) {
    for (const item of items) {
      if (!item.package) continue;
      for (const path of item.paths ?? []) {
        if (!existsSync(join(repo, 'tools', item.package, path))) missing.push(`${row}: tools/${item.package}/${path}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'a tool row names a file that is not in the tree: point it at where the file moved, or drop it');
});

test('no tool row places one package folder twice', () => {
  // The engine never replaces a file it already laid out for a run (trillion-rust container.rs copy_file), so a package
  // placed twice at one folder refuses every run of the row: a row declared split2 while the walk added its lockfile key
  // node_modules/split2 at the same /opt/node_modules/split2, and all four noticer wakes stopped on Nov 19 2026 at 5:27 PM CST.
  const rows = JSON.parse(readFileSync(join(repo, PACKAGE_FILES), 'utf8'));
  const twice = [];
  for (const [row, items] of Object.entries(rows)) {
    const ats = items.filter(item => item.packages).map(item => item.at);
    for (const at of new Set(ats.filter((at, index) => ats.indexOf(at) !== index))) twice.push(`${row}: ${at}`);
  }
  assert.deepEqual(twice, [], 'a package folder is placed twice: the walk must skip a package the row already places (tool-row-imports.mjs `placed`)');
});

test('every place a row is laid out with is laid once: no path again, and none inside a folder the row already lays', () => {
  // The engine never replaces a file it laid (container.rs copy_file) and lays them read-only, so a second copy stops every run
  // of the row; on Nov 19 2026 at 6:55 PM CST every workflow run on the Mac failed this way. The rule is the pin tool's
  // duplicateLayouts, the same one that refuses to pin such a commit, so the two never drift apart.
  const rows = JSON.parse(readFileSync(join(repo, PACKAGE_FILES), 'utf8'));
  const twice = duplicateLayouts(rows).map(({ row, key, inside }) => `${row}: ${key}${inside ? ` inside ${inside}` : ''}`);
  assert.deepEqual(twice.slice(0, 20), [], 'a row lays one place twice: drop the later path (test-helpers/tool-row-imports.mjs layOnce)');
});
