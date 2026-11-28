// Integration, against real git repositories: an upstream change comes to the project as a branch, merged only for a
// trusted source whose project tests pass (plan B4), else waiting on its branch; a project edit goes upstream through the
// source's landing owner when one is named, else as branch sync/<project>/<tool> pushed with --force-with-lease, and
// offering it again pushes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileDigest } from '../../content-identity/read-data/manifest.mjs';
import { RECORD_FILE, TOOLS_FOLDER } from '../../add-a-tool-to-a-project/read-data/record.ts';
import { apply, ownerOf, plan } from '../do-work/sync.ts';
import { GREEN, OWNED, RED, TEXT, commitUpstream, git, makeUpstream, projectWith, setRecord, standInLanding, toolFiles, writeRegistry } from './fixtures.ts';
import { scratch } from '../../add-a-tool-to-a-project/test/fixtures.ts';

const record = (project: string) => JSON.parse(readFileSync(join(project, TOOLS_FOLDER, RECORD_FILE), 'utf8'));
const runFile = (project: string) => join(project, TOOLS_FOLDER, 'greet', 'do-work', 'run.mjs');

/** A project with greet copied from an owner's address, then an upstream commit that changes run.mjs and drops gone.mjs. */
async function upstreamMoved(fields: Record<string, unknown>) {
  const up = makeUpstream({ ...toolFiles('greet'), 'tools/greet/do-work/gone.mjs': 'old\n' });
  const { project, registry } = await projectWith(up, ['greet']);
  const clones = [up.work, registry];
  setRecord(project, fields);
  const next = commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('six', 'SIX'), 'tools/greet/do-work/gone.mjs': null, 'tools/greet/do-work/new.mjs': 'new\n' });
  writeRegistry(registry, up, ['greet'], next, OWNED);
  // The project's line names the same pointer at its old commit; only the registry moved.
  return { up, project, registry, clones, next };
}

test('the owner of an address is read from it, and a folder has none', () => {
  assert.equal(ownerOf('https://github.com/Example-Org/shared-tools.git'), 'example-org');
  assert.equal(ownerOf('git@example.com:some-owner/registry-of-tools.git'), 'some-owner');
  assert.equal(ownerOf('/a/local/folder'), null);
});

test('a trusted source whose project tests pass is merged: the branch fast-forwards the project and the record advances', async () => {
  const { project, clones, next } = await upstreamMoved({ trust: ['example-owner'], test: GREEN });
  const head = git(project, 'rev-parse', 'HEAD');
  const planned = await plan({ project, clones, fact: { where: 'github:registry', place: 'refs/heads/main', key: next } });
  assert.equal(planned.tools.greet.state, 'upstream-only');
  assert.deepEqual(planned.because, { where: 'github:registry', place: 'refs/heads/main', key: next });
  const done = await apply({ project, clones, plan: planned });
  assert.deepEqual(done.settled, ['greet']);
  assert.deepEqual(done.waiting, []);
  assert.match(done.gap!, /No GitHub key/);
  assert.equal(git(project, 'rev-parse', 'HEAD^'), head, 'one commit on the project HEAD');
  assert.equal(git(project, 'rev-parse', 'HEAD'), git(project, 'rev-parse', 'refs/heads/sync/upstream/trusted'));
  assert.equal(git(project, 'status', '--porcelain'), '', 'the merge leaves nothing uncommitted');
  assert.equal(readFileSync(runFile(project), 'utf8'), TEXT.replace('six', 'SIX'));
  assert.equal(existsSync(join(project, TOOLS_FOLDER, 'greet', 'do-work', 'gone.mjs')), false);
  const line = record(project).tools.greet;
  assert.equal(line.copied_at_commit, next);
  assert.equal(line.files['do-work/run.mjs'], fileDigest(Buffer.from(TEXT.replace('six', 'SIX'))));
  assert.equal(line.files['do-work/gone.mjs'], undefined);
  const again = await apply({ project, clones, plan: await plan({ project, clones }) });
  assert.deepEqual(again.unchanged, ['greet'], 'a second sync finds nothing to do');
});

test('a source whose owner is not trusted waits on its branch; the project files and HEAD do not move', async () => {
  const { project, clones, next } = await upstreamMoved({ trust: ['someone-else'], test: GREEN });
  const head = git(project, 'rev-parse', 'HEAD');
  const done = await apply({ project, clones, plan: await plan({ project, clones }) });
  assert.deepEqual(done.settled, []);
  assert.deepEqual(done.waiting.map(w => [w.tools, w.branch, w.why, w.pull_request]), [[['greet'], 'sync/upstream/greet', 'not-trusted', null]]);
  assert.equal(git(project, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(runFile(project), 'utf8'), TEXT);
  assert.equal(git(project, 'show', `sync/upstream/greet:${TOOLS_FOLDER}/greet/do-work/run.mjs`), TEXT.replace('six', 'SIX').trimEnd());
  assert.equal(JSON.parse(git(project, 'show', `sync/upstream/greet:${TOOLS_FOLDER}/${RECORD_FILE}`)).tools.greet.copied_at_commit, next, 'the branch carries the advanced line');
  const again = await apply({ project, clones, plan: await plan({ project, clones }) });
  assert.equal(again.waiting[0].commit, done.waiting[0].commit, 'the same change makes the same branch commit');
});

test('a trusted source whose project tests fail, or a record with no test, waits on its branch', async () => {
  const red = await upstreamMoved({ trust: ['example-owner'], test: RED });
  const failed = await apply({ project: red.project, clones: red.clones, plan: await plan({ project: red.project, clones: red.clones }) });
  assert.deepEqual(failed.waiting.map(w => [w.branch, w.why]), [['sync/upstream/trusted', 'tests-not-green']]);
  assert.match(failed.waiting[0].said, /one test failed/);
  assert.equal(readFileSync(runFile(red.project), 'utf8'), TEXT);
  const none = await upstreamMoved({ trust: ['example-owner'] });
  const untested = await apply({ project: none.project, clones: none.clones, plan: await plan({ project: none.project, clones: none.clones }) });
  assert.deepEqual(untested.waiting.map(w => w.why), ['no-test-command']);
});

test('a project-only edit is pushed upstream as a sync branch with a lease, and offering it again pushes nothing', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project, clones } = await projectWith(up, ['greet']);
  writeFileSync(runFile(project), TEXT.replace('one', 'ONE'));
  const recordBefore = readFileSync(join(project, TOOLS_FOLDER, RECORD_FILE));
  const planned = await plan({ project, clones });
  assert.equal(planned.tools.greet.state, 'project-only');
  const done = await apply({ project, clones, plan: planned });
  const branch = `sync/${basename(project).toLowerCase()}/greet`;
  assert.deepEqual(done.pushed.map(p => [p.tool, p.branch, p.already]), [['greet', branch, false]]);
  assert.deepEqual(readFileSync(join(project, TOOLS_FOLDER, RECORD_FILE)), recordBefore, 'the record does not move');
  assert.equal(git(up.bare, 'rev-parse', `refs/heads/${branch}`), done.pushed[0].commit);
  assert.equal(git(up.bare, 'rev-parse', `${done.pushed[0].commit}^`), up.commit, 'made on the upstream commit');
  assert.equal(git(up.bare, 'show', `${branch}:tools/greet/do-work/run.mjs`), TEXT.replace('one', 'ONE').trimEnd());
  assert.equal(git(up.bare, 'rev-parse', 'refs/heads/main'), up.commit, 'main is never pushed');
  const again = await apply({ project, clones, plan: await plan({ project, clones }) });
  assert.deepEqual(again.pushed.map(p => [p.branch, p.already, p.commit]), [[branch, true, done.pushed[0].commit]]);
});

test('a both-sides merge from a trusted source lands in the project and goes upstream through the named landing owner', async () => {
  const { project, clones } = await upstreamMoved({ trust: ['example-owner'], test: GREEN });
  writeFileSync(runFile(project), TEXT.replace('one', 'ONE'));
  git(project, '-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-am', 'project edit');
  const log = join(scratch('landing-log'), 'log.jsonl');
  const planned = await plan({ project, clones });
  assert.equal(planned.tools.greet.state, 'both-clean');
  const done = await apply({ project, clones, plan: planned, land_through: [{ repo: OWNED, command: standInLanding(log) }] });
  const merged = TEXT.replace('one', 'ONE').replace('six', 'SIX');
  assert.deepEqual(done.settled, ['greet']);
  assert.equal(readFileSync(runFile(project), 'utf8'), merged);
  assert.deepEqual(done.pushed.map(p => [p.tool, p.branch, p.commit]), [['greet', null, 'a'.repeat(40)]]);
  const landed = JSON.parse(readFileSync(log, 'utf8').trim());
  assert.deepEqual(landed.edited, [{ path: 'tools/greet/do-work/run.mjs', text: merged }]);
  assert.ok(landed.words.includes('--message-file') && landed.words.includes('--lane'));
});

test('commits are read from a local clone when the owner\'s address cannot be reached, and the offer upstream there is refused by name', async () => {
  const { project, clones } = await upstreamMoved({ trust: ['example-owner'], test: GREEN });
  writeFileSync(runFile(project), TEXT.replace('one', 'ONE'));
  git(project, '-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-am', 'project edit');
  const planned = await plan({ project, clones });
  assert.equal(planned.tools.greet.state, 'both-clean');
  const done = await apply({ project, clones, plan: planned });
  assert.deepEqual(done.settled, ['greet']);
  assert.deepEqual(done.refused.map(r => [r.tool, r.why]), [['greet', 'push-refused']]);
  assert.deepEqual(done.pushed, []);
});
