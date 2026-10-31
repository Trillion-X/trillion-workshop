// tools/git-changes: the command templates, the reading of `git status --porcelain --branch`, and the five tools run
// against a real git in a throwaway folder (synthetic files and a made-up author), plus the rows that name them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tools from '../read-data/git-changes.mjs';

const { renderArgv, parseBranchHeader, parsePorcelain } = tools;
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map((record) => record.payload);

// The tests make their own repositories, so no repository, work tree or index the caller's environment names may reach git.
const commands = JSON.parse(readFileSync(new URL('../read-data/git-commands.json', import.meta.url), 'utf8'));
for (const name of commands.drop_env) delete process.env[name];

// A made-up author and no machine-wide git settings, so a commit here is the same on every computer.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Sample Person', GIT_AUTHOR_EMAIL: 'sample@example.invalid',
  GIT_COMMITTER_NAME: 'Sample Person', GIT_COMMITTER_EMAIL: 'sample@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
});

function pretendProject() {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'git-changes-')));
  execFileSync('git', ['-C', folder, 'init', '-q', '-b', 'main']);
  writeFileSync(join(folder, 'notes.txt'), 'first line\n');
  execFileSync('git', ['-C', folder, 'add', '--', 'notes.txt']);
  execFileSync('git', ['-C', folder, 'commit', '-q', '-m', 'Start the notes']);
  return folder;
}

test('a command template becomes the argument list it stands for', () => {
  const project = { path: '/projects/sample' };
  assert.deepEqual(renderArgv(['git', '-C', { from: 'project', path: 'path' }, 'add', '--', { from: 'input', path: 'paths', spread: true }], project, { paths: ['a.txt', '', 'b c.txt', 7] }),
    ['git', '-C', '/projects/sample', 'add', '--', 'a.txt', 'b c.txt']);
  assert.deepEqual(renderArgv(['git', { from: 'input', path: 'missing' }, { literal: 'x' }], project, {}), ['git', 'x']);
  assert.throws(() => renderArgv('git status', project, {}), /argv array/);
  assert.throws(() => renderArgv([{ from: 'input', path: 'nothing' }], project, {}), /empty argv/);
});

test('the branch line gives the name and how far ahead and behind it is', () => {
  assert.deepEqual(parseBranchHeader('## main...origin/main [ahead 2, behind 3]'), { branch: 'main', ahead: 2, behind: 3 });
  assert.deepEqual(parseBranchHeader('## feature/x'), { branch: 'feature/x', ahead: 0, behind: 0 });
  assert.deepEqual(parseBranchHeader('## main...origin/main [behind 1]'), { branch: 'main', ahead: 0, behind: 1 });
  assert.deepEqual(parseBranchHeader('## '), { branch: 'HEAD', ahead: 0, behind: 0 });
});

test('status lines become one row per file per bucket, staged first and each bucket in name order', () => {
  const read = parsePorcelain([
    '## main...origin/main [ahead 1]',
    '?? zebra.txt', '?? alpha.txt',
    ' M edited.txt', 'M  ready.txt', 'MM both.txt', 'A  added.txt', 'R  old-name.txt -> new-name.txt', '',
  ].join('\n'));
  assert.equal(read.branch, 'main');
  assert.equal(read.ahead, 1);
  assert.deepEqual(read.changes.map((row) => `${row.bucket}:${row.status}:${row.file_path}`), [
    'staged:A:added.txt', 'staged:M:both.txt', 'staged:R:new-name.txt', 'staged:M:ready.txt',
    'unstaged:M:both.txt', 'unstaged:M:edited.txt',
    'untracked:?:alpha.txt', 'untracked:?:zebra.txt',
  ]);
});

test('a project is seen, a file staged, unstaged, seen as a difference and committed, in a real git', async () => {
  const folder = pretendProject();
  assert.deepEqual(await tools.seeChangesInAProject({ folder }), { folder, branch: 'main', ahead: 0, behind: 0, changes: [] });

  writeFileSync(join(folder, 'notes.txt'), 'first line\nsecond line\n');
  writeFileSync(join(folder, 'plan.txt'), 'plan\n');
  const seen = await tools.seeChangesInAProject({ folder });
  assert.deepEqual(seen.changes.map((row) => `${row.bucket}:${row.file_path}`), ['unstaged:notes.txt', 'untracked:plan.txt']);

  const diff = await tools.seeAFilesChange({ folder, file_path: 'notes.txt' });
  assert.match(diff.diff, /\+second line/);

  const staged = await tools.stageChanges({ folder, paths: ['notes.txt', 'plan.txt'] });
  assert.deepEqual(staged.changes.map((row) => `${row.bucket}:${row.status}:${row.file_path}`), ['staged:M:notes.txt', 'staged:A:plan.txt']);

  const unstaged = await tools.unstageChanges({ folder, paths: ['plan.txt'] });
  assert.deepEqual(unstaged.changes.map((row) => `${row.bucket}:${row.file_path}`), ['staged:notes.txt', 'untracked:plan.txt']);
  assert.equal(readFileSync(join(folder, 'plan.txt'), 'utf8'), 'plan\n', 'unstaging leaves the file as it is');

  const committed = await tools.commitChanges({ folder, message: 'Add a second line' });
  assert.deepEqual(committed.changes.map((row) => `${row.bucket}:${row.file_path}`), ['untracked:plan.txt']);
  assert.equal(execFileSync('git', ['-C', folder, 'log', '-1', '--format=%s']).toString().trim(), 'Add a second line');
});

test('a message that begins with a dash is a message, and a file name that begins with a dash is a file', async () => {
  const folder = pretendProject();
  writeFileSync(join(folder, '-odd.txt'), 'x\n');
  await tools.stageChanges({ folder, paths: ['-odd.txt'] });
  await tools.commitChanges({ folder, message: '--amend is only words here' });
  assert.equal(execFileSync('git', ['-C', folder, 'log', '-1', '--format=%s']).toString().trim(), '--amend is only words here');
});

test('every refusal says what to give, and git\'s own words come back when git refuses', async () => {
  const folder = pretendProject();
  await assert.rejects(tools.seeChangesInAProject({ folder: 'relative/path' }), /full path of the project/);
  await assert.rejects(tools.seeChangesInAProject({}), /full path of the project/);
  await assert.rejects(tools.seeAFilesChange({ folder }), /Give file_path/);
  await assert.rejects(tools.stageChanges({ folder, paths: [] }), /Give paths/);
  await assert.rejects(tools.unstageChanges({ folder, paths: ['ok.txt', 7] }), /Give paths/);
  await assert.rejects(tools.commitChanges({ folder, message: '' }), /Give message/);
  await assert.rejects(tools.commitChanges({ folder, message: 'Nothing staged' }), /nothing to commit|nothing added to commit|no changes added/);
  const notAProject = realpathSync(mkdtempSync(join(tmpdir(), 'git-changes-none-')));
  await assert.rejects(tools.seeChangesInAProject({ folder: notAProject }), /not a git repository/);
});

test('a command that prints past the bound in the commands DATA is stopped and refused', async () => {
  const bound = JSON.parse(readFileSync(new URL('../read-data/git-commands.json', import.meta.url), 'utf8')).most_bytes;
  await assert.rejects(tools.startGit(['node', '-e', `process.stdout.write('x'.repeat(${bound + 1000}))`]), /too much to return/);
});

test('a function given a git of its own runs that one, so the tools can be tried with no repository', async () => {
  const seen = await tools.seeChangesInAProject({ folder: '/projects/sample' }, null, { git: async (argv) => ({ code: 0, stdout: `## main\n?? one.txt\n`, stderr: argv.join(' ') }) });
  assert.deepEqual(seen, { folder: '/projects/sample', branch: 'main', ahead: 0, behind: 0, changes: [{ file_path: 'one.txt', bucket: 'untracked', status: '?' }] });
});

test('each row names a function this module has, runs it on the person\'s computer and holds git in one folder', () => {
  assert.deepEqual(rows.map((row) => row.id).sort(), ['tool:commit-changes', 'tool:see-a-files-change', 'tool:see-changes-in-a-project', 'tool:stage-changes', 'tool:unstage-changes']);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'computer');
    assert.deepEqual(row.invoke.capabilities, ['use-git-in-a-folder']);
    assert.deepEqual(row.placements, ['placement:your-computer']);
    assert.equal(typeof tools[row.invoke.argv.at(-1)], 'function', `${row.id} runs ${row.invoke.argv.at(-1)}`);
    assert.ok(row.input_schema.required.includes('folder'));
  }
});
