// scripts/workspace-source-record.mjs: the web client's record of which inputs the commit it names holds byte for byte, and the refusal that
// keeps a client built from anything else out of the Mac app. Real repositories and real `git cat-file`.
import { tempFolder } from '../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { SOURCE_RECORD_FILE, buildCommit, refuseUnrecordedSource, sourceRecord } from 'trillion-workshop/tools/native-space-source-release/scripts/workspace-source-record.mjs';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());

/** A committed repository holding the inputs a build read, and a way to write more files. */
function repository(files) {
  const root = realpathSync(tempFolder(join(tmpdir(), 'source-record-')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env }).trim();
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  git('init', '-q');
  for (const [path, text] of Object.entries(files)) put(path, text);
  git('add', '-A'); git('commit', '-q', '-m', 'fixture');
  return { root, git, put, commit: git('rev-parse', 'HEAD') };
}
const INPUTS = ['src/a.tsx', 'parts/ui/b.css', 'node_modules/react/index.js'];
const FILES = { 'src/a.tsx': 'export const a = 1;\n', 'parts/ui/b.css': '.b { color: red }\n', 'node_modules/react/index.js': 'react\n' };

test('inputs the commit holds byte for byte leave nothing differing, and dependencies are not judged', () => {
  const { root, commit } = repository(FILES);
  assert.deepEqual(sourceRecord({ root, inputs: INPUTS, commit, repo: root }), { version: 'workspace-source/v1', commit, differing: [] });
});

test('an edited input, an uncommitted input and a deleted input are each named; the commit is the judge, not the disk', () => {
  const { root, put, commit, git } = repository(FILES);
  put('src/a.tsx', 'export const a = 2;\n');
  put('src/new.tsx', 'export const n = 1;\n');
  git('rm', '-q', '--cached', 'parts/ui/b.css');
  const record = sourceRecord({ root, inputs: [...INPUTS, 'src/new.tsx', 'src/gone.tsx'], commit: git('rev-parse', 'HEAD'), repo: root });
  assert.deepEqual(record.differing, ['src/a.tsx', 'src/gone.tsx', 'src/new.tsx']);
  assert.equal(record.commit, commit);
});

test('an export with no repository and no named commit records no commit; a commit named from outside is judged in the repository named', () => {
  const { root: repo, commit } = repository(FILES);
  const exportRoot = realpathSync(tempFolder(join(tmpdir(), 'source-export-')));
  for (const [path, text] of Object.entries(FILES)) { mkdirSync(dirname(join(exportRoot, path)), { recursive: true }); writeFileSync(join(exportRoot, path), text); }
  assert.equal(buildCommit(exportRoot, {}), null);
  assert.deepEqual(sourceRecord({ root: exportRoot, inputs: INPUTS, commit: null, repo: exportRoot }), { version: 'workspace-source/v1', commit: null, differing: null });
  assert.equal(buildCommit(exportRoot, { WORKSPACE_SOURCE_COMMIT: commit }), commit);
  assert.deepEqual(sourceRecord({ root: exportRoot, inputs: INPUTS, commit, repo }).differing, []);
  writeFileSync(join(exportRoot, 'src/a.tsx'), 'edited\n');
  assert.deepEqual(sourceRecord({ root: exportRoot, inputs: INPUTS, commit, repo }).differing, ['src/a.tsx']);
});

test('a client built in a folder of the repository asks the commit at the folder\'s paths and names the repository paths that differ', () => {
  const { root: repo, put, commit } = repository(Object.fromEntries(Object.entries(FILES).map(([path, text]) => [`web/${path}`, text])));
  const root = join(repo, 'web');
  assert.deepEqual(sourceRecord({ root, inputs: INPUTS, commit, repo, prefix: 'web/' }).differing, []);
  assert.deepEqual(sourceRecord({ root, inputs: INPUTS, commit, repo }).differing, ['parts/ui/b.css', 'src/a.tsx']);
  put('web/src/a.tsx', 'edited\n');
  assert.deepEqual(sourceRecord({ root, inputs: INPUTS, commit, repo, prefix: 'web/' }).differing, ['web/src/a.tsx']);
  for (const prefix of ['web', '/web/', '../web/', 'web//']) assert.throws(() => sourceRecord({ root, inputs: INPUTS, commit, repo, prefix }), /folder names ending in \//);
});

test('a client built inside an installed Workshop asks the commit at each input\'s path from the Workshop\'s folder, and judges no dependency', () => {
  const { root: repo, put, commit } = repository({ 'tools/client/src/a.tsx': 'a\n', 'tools/ui/b.css': 'b\n', 'node_modules/react/index.js': 'react\n' });
  const root = join(repo, 'tools/client');
  const from = path => relative(root, join(repo, path));
  const inputs = ['src/a.tsx', from('tools/ui/b.css'), from('node_modules/react/index.js')];
  assert.deepEqual(sourceRecord({ root, inputs, commit, repo, treeRoot: repo }), { version: 'workspace-source/v1', commit, differing: [] });
  put('tools/ui/b.css', 'edited\n');
  assert.deepEqual(sourceRecord({ root, inputs, commit, repo, treeRoot: repo }).differing, ['tools/ui/b.css']);
  // A file outside the Workshop that is not a dependency is not held by any commit of it.
  const stranger = join(realpathSync(tempFolder(join(tmpdir(), 'source-outside-'))), 'x.txt');
  writeFileSync(stranger, 'x\n');
  assert.deepEqual(sourceRecord({ root, inputs: [inputs[0], relative(root, stranger)], commit, repo, treeRoot: repo }).differing, [relative(root, stranger)]);
});

test('the app takes a client only when its record names a commit and lists no differing input', () => {
  const built = realpathSync(tempFolder(join(tmpdir(), 'source-built-')));
  const write = record => writeFileSync(join(built, SOURCE_RECORD_FILE), JSON.stringify(record));
  const commit = 'a'.repeat(40);
  assert.throws(() => refuseUnrecordedSource(built), /has no workspace\.source\.json, so what it was built from is unknown/);
  write({ version: 'workspace-source/v1', commit: null, differing: null });
  assert.throws(() => refuseUnrecordedSource(built), /built from no commit/);
  write({ version: 'workspace-source/v1', commit, differing: ['src/a.tsx', 'src/b.tsx'] });
  assert.throws(() => refuseUnrecordedSource(built), /2 inputs that commit aaaaaaaaaa does not hold \(src\/a\.tsx, src\/b\.tsx\)\. Build it from a clean commit/);
  write({ version: 'workspace-source/v1', commit, differing: Array.from({ length: 8 }, (_, index) => `src/f${index}.tsx`) });
  assert.throws(() => refuseUnrecordedSource(built), /8 inputs .*src\/f4\.tsx, \.\.\.\)/);
  write({ version: 'workspace-source/v1', commit, differing: [] });
  assert.deepEqual(refuseUnrecordedSource(built), { version: 'workspace-source/v1', commit, differing: [] });
});

test('a repository made with no commit yet (visual-check\'s Linux copy runs git init) records no commit', () => {
  const root = realpathSync(tempFolder(join(tmpdir(), 'source-no-commit-')));
  execFileSync('git', ['-C', root, 'init', '-q']);
  assert.equal(buildCommit(root, {}), null);
  assert.equal(buildCommit(root, { WORKSPACE_SOURCE_COMMIT: 'a'.repeat(40) }), 'a'.repeat(40));
});
