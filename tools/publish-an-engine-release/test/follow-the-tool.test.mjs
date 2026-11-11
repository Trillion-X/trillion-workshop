// The builder follows trillion-workshop main: each test makes a made-up repository holding the shipped files, and a tool folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync as dir } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { followTheTool, readStatus, tipOf } from '../do-work/follow-the-tool.mjs';
import { SHIPPED } from '../do-work/install-a-builder.mjs';

const DIRECTORIES = ['tools/publish-an-engine-release/do-work', 'tools/publish-an-engine-release/read-data', 'tools/content-identity/read-data'];
const sh = (cwd, ...args) => {
  const ran = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' } });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
};

// A made-up trillion-workshop: every shipped path written, the publisher's do-work file saying which version it is.
function repository(version) {
  const top = mkdtempSync(join(tmpdir(), 'follow-the-tool-')), work = join(top, 'source');
  mkdirSync(work);
  sh(work, 'init', '-q', '-b', 'main');
  for (const path of SHIPPED) {
    const full = join(work, path);
    if (DIRECTORIES.includes(path)) { dir(full, { recursive: true }); writeFileSync(join(full, 'file.mjs'), `export const version = '${version}';\n`); }
    else { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, `${path} ${version}\n`); }
  }
  sh(work, 'add', '.');
  sh(work, 'commit', '-q', '-m', version);
  return { top, source: `file://${work}`, commit: sh(work, 'rev-parse', 'HEAD'), work };
}

const setup = () => {
  const top = mkdtempSync(join(tmpdir(), 'builder-tool-'));
  return { tool: join(top, 'tool'), status: join(top, 'tool-status.json') };
};
const versionOf = tool => readFileSync(join(tool, 'tools/publish-an-engine-release/do-work/file.mjs'), 'utf8');

test('the branch tip is installed, its commit is recorded, and the receiver restarts once', async () => {
  const first = repository('one'), { tool, status } = setup();
  const restarts = [];
  const answer = await followTheTool({ source: first.source, branch: 'main', tool, status, restart: () => restarts.push(1) });
  assert.deepEqual([answer.changed, answer.commit, answer.previous], [true, first.commit, null]);
  assert.match(versionOf(tool), /version = 'one'/);
  assert.equal(readStatus(status).commit, first.commit);
  assert.equal(restarts.length, 1);
});

test('the same tip again changes nothing and restarts nothing', async () => {
  const first = repository('one'), { tool, status } = setup();
  await followTheTool({ source: first.source, branch: 'main', tool, status, restart: () => {} });
  const restarts = [];
  const answer = await followTheTool({ source: first.source, branch: 'main', tool, status, restart: () => restarts.push(1) });
  assert.deepEqual([answer.changed, answer.commit], [false, first.commit]);
  assert.equal(restarts.length, 0);
});

test('a newer tip replaces the tool, keeps the one it replaced beside it as tool.old, and records both commits', async () => {
  const first = repository('one'), { tool, status } = setup();
  await followTheTool({ source: first.source, branch: 'main', tool, status, restart: () => {} });
  const second = repository('two');
  const answer = await followTheTool({ source: second.source, branch: 'main', tool, status, restart: () => {} });
  assert.deepEqual([answer.changed, answer.commit, answer.previous], [true, second.commit, first.commit]);
  assert.match(versionOf(tool), /version = 'two'/);
  assert.match(readFileSync(join(`${tool}.old`, 'tools/publish-an-engine-release/do-work/file.mjs'), 'utf8'), /version = 'one'/, 'the previous tool is kept for rollback');
  assert.deepEqual([readStatus(status).commit, readStatus(status).previous], [second.commit, first.commit]);
  assert.ok(!existsSync(`${tool}.new`), 'no staged folder is left behind');
});

test('a branch that is gone, or a commit that cannot be staged, leaves the installed tool as it is', async () => {
  const first = repository('one'), { tool, status } = setup();
  await followTheTool({ source: first.source, branch: 'main', tool, status, restart: () => {} });
  assert.throws(() => tipOf({ source: first.source, branch: 'no-such-branch' }), /names no no-such-branch branch/);
  // The shipped file the next commit lacks, and no installed copy of it either: the stage refuses before any rename.
  const broken = repository('two');
  const work = broken.work;
  sh(work, 'rm', '-q', 'test-helpers/tool-row-imports.mjs');
  sh(work, 'commit', '-q', '-m', 'lost a shipped file');
  const lost = sh(work, 'rev-parse', 'HEAD');
  await assert.rejects(followTheTool({ source: `file://${work}`, branch: 'main', tool, status, restart: () => {} }), /test-helpers\/tool-row-imports\.mjs/);
  assert.match(versionOf(tool), /version = 'one'/, 'the installed tool is unchanged');
  assert.equal(readStatus(status).commit, first.commit);
  assert.notEqual(lost, first.commit);
});
