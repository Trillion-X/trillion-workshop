// test/tool-row-start-files.test.mjs
//
// Every tool row starts with every file its programs need at start: each module the row's entry reaches through an import,
// and each file those modules read at run time (new URL('./x.json', import.meta.url), a literal relative readFileSync).
// The engine lays a row out with the files package-files.json names for it (test-helpers/write-package-files.mjs), so a file
// a module reads that the row's laid-out files do not hold makes the row crash on start (a read of a missing file, exit 1).
// This test checks the laid-out files (packageFilesByRow), not only the files the row declares.
import { tempFolder } from '../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toolRowFindings } from '../test-helpers/tool-row-imports.mjs';

const repo = resolve(import.meta.dirname, '..');
const STARTS_NEED = ['missing-relative-import', 'read-file-not-packed'];

// The check tree of a landing is an export with no .git of its own: it is committed into a throwaway git folder, as in
// test/every-tool-row-imports.test.mjs.
function judgedTree() {
  if (existsSync(join(repo, '.git'))) return { env: {}, ref: 'HEAD' };
  const gitDir = tempFolder(join(tmpdir(), 'tool-row-start-git-'));
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: repo, GIT_INDEX_FILE: join(gitDir, 'index'), GIT_AUTHOR_NAME: 'check', GIT_AUTHOR_EMAIL: 'check@example.test', GIT_COMMITTER_NAME: 'check', GIT_COMMITTER_EMAIL: 'check@example.test' };
  const git = args => execFileSync('git', args, { env: { ...process.env, ...env }, maxBuffer: 2 ** 30 }).toString().trim();
  git(['init', '-q']);
  git(['add', '-A', '-f', '.']);
  return { env, ref: git(['commit-tree', git(['write-tree']), '-m', 'check tree']) };
}

// Whether a laid-out item (package, paths, at) holds the workshop file `file` (tools/<package>/<rel>) at its installed place.
const laidOut = (items, file) => {
  const [, pkg, ...rest] = file.split('/');
  const rel = rest.join('/');
  return items.some(item => item.package === pkg && !String(item.at).startsWith('/opt/node_modules/')
    && (item.paths || []).some(path => { const p = path.replace(/\/$/, ''); return p === '.' || rel === p || rel.startsWith(p + '/'); }));
};

test('every tool row lays out every file its programs reach at start, including the files they read at run time', () => {
  const { env, ref } = judgedTree();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  let results, byRow;
  try { ({ results, byRow } = toolRowFindings({ repo, ref })); } finally { for (const key of Object.keys(env)) { if (key in saved) process.env[key] = saved[key]; else delete process.env[key]; } }
  const missing = results.flatMap(row => (row.findings || [])
    .filter(f => STARTS_NEED.includes(f.kind))
    .filter(f => !laidOut(byRow[row.id] || [], f.needs))
    .map(f => `${row.row_file} ${row.id}: ${f.kind} ${f.needs} (read or imported from ${f.from})`));
  assert.deepEqual(missing, [], `\n${missing.join('\n')}\n\nThe generator lays out every file a module reads at run time: re-run test-helpers/write-package-files.mjs.`);
});

test('the run-time file of the shared read helper is laid out for the rows that import it', () => {
  const { env, ref } = judgedTree();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  let byRow;
  try { ({ byRow } = toolRowFindings({ repo, ref })); } finally { for (const key of Object.keys(env)) { if (key in saved) process.env[key] = saved[key]; else delete process.env[key]; } }
  const rows = Object.keys(byRow).filter(id => laidOut(byRow[id], 'tools/workflows/read-data/whole-file.mjs'));
  assert.ok(rows.length > 0, 'some row lays out the whole-file reader');
  for (const id of rows) assert.ok(laidOut(byRow[id], 'tools/workflows/read-data/large-file.json'), `${id} lays out the large-file settings the reader reads at start`);
});
