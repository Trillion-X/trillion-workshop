// Integration, against real git repositories, the project's remote a local bare repository standing in for GitHub: an
// upstream change comes to the project only as branch sync/upstream/<record line>/<upstream commit>, pushed without
// force on the tip of main, which never moves; two runs of one change make one branch and one would_open; every other
// ref is refused before git starts; a pointer's `paths` bound what upstream is, so a dropped file is never added again;
// project changes stay in the project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileDigest, identityOfDigests } from '../../content-identity/read-data/manifest.mjs';
import { RECORD_FILE, TOOLS_FOLDER } from '../../add-a-tool-to-a-project/read-data/record.ts';
import { RefRefused, apply, plan, pushSyncBranch, syncRef } from '../do-work/sync.ts';
import { TEXT, commitUpstream, git, makeUpstream, projectWith, publish, refsOf, toolFiles, writeRegistry, type Upstream } from './fixtures.ts';

const MAIN = 'refs/heads/main';
const show = (repo: string, at: string) => execFileSync('git', ['-C', repo, 'show', at], { encoding: 'utf8' });
const recordAt = (repo: string, ref: string) => JSON.parse(show(repo, `${ref}:${TOOLS_FOLDER}/${RECORD_FILE}`));
const syncRefs = (repo: string) => Object.keys(refsOf(repo)).filter(ref => ref.startsWith('refs/heads/sync/'));

/** A registry pointer at `commit` that takes only `paths` of tools/<name>, its files_blake3 over exactly those files. */
function pathsRegistry(registry: string, up: Upstream, name: string, paths: string[], commit = up.commit): void {
  const digests = Object.fromEntries(paths.map(path => [path, fileDigest(execFileSync('git', ['-C', up.work, 'show', `${commit}:tools/${name}/${path}`]))]));
  const tools = { [name]: { repo: up.bare, path: `tools/${name}`, commit, paths, files_blake3: identityOfDigests(digests), what_it_does: `The stand-in ${name}.`, needs_tools: [] } };
  writeFileSync(join(registry, 'tools-in-this-registry.json'), `${JSON.stringify({ _what: 'A stand-in registry.', tools }, null, 2)}\n`);
}

test('an upstream change waits on branch sync/upstream/<line>/<commit> made on main, and main never moves', async () => {
  const up = makeUpstream({ ...toolFiles('greet'), 'tools/greet/do-work/gone.mjs': 'old\n' });
  const { registry, clones, at } = await projectWith(up, ['greet']);
  const main = refsOf(at.repo)[MAIN];
  const next = commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('six', 'SIX'), 'tools/greet/do-work/gone.mjs': null, 'tools/greet/do-work/new.mjs': 'new\n' });
  writeRegistry(registry, up, ['greet']);
  const planned = await plan({ ...at, clones, fact: { where: 'github:registry', place: MAIN, key: next } });
  assert.equal(planned.tools.greet.state, 'upstream-only');
  assert.deepEqual(planned.because, { where: 'github:registry', place: MAIN, key: next });
  const done = await apply({ ...at, clones, plan: planned });
  const branch = `sync/upstream/greet/${next}`;
  assert.deepEqual(done.waiting.map(w => [w.tools, w.branch, w.created, w.would_open, w.pull_request]), [[['greet'], branch, true, true, null]]);
  assert.match(done.gap!, /No GitHub key/);
  assert.equal(refsOf(at.repo)[MAIN], main, 'main is never moved');
  assert.equal(refsOf(at.repo)[`refs/heads/${branch}`], done.waiting[0].commit);
  assert.equal(git(at.repo, 'rev-parse', `${branch}^`), main, 'the branch is one commit on the tip of main');
  assert.equal(show(at.repo, `${branch}:${TOOLS_FOLDER}/greet/do-work/run.mjs`), TEXT.replace('six', 'SIX'));
  assert.throws(() => show(at.repo, `${branch}:${TOOLS_FOLDER}/greet/do-work/gone.mjs`), 'a file upstream deleted is gone on the branch');
  const line = recordAt(at.repo, branch).tools.greet;
  assert.equal(line.copied_at_commit, next);
  assert.equal(line.files['do-work/new.mjs'], fileDigest(Buffer.from('new\n')));
});

test('two runs of the same change make exactly one branch and one would_open', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { registry, clones, at } = await projectWith(up, ['greet']);
  const next = commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('two', 'TWO') });
  writeRegistry(registry, up, ['greet']);
  const first = await apply({ ...at, clones, plan: await plan({ ...at, clones }) });
  const second = await apply({ ...at, clones, plan: await plan({ ...at, clones }) });
  assert.deepEqual(syncRefs(at.repo), [`refs/heads/sync/upstream/greet/${next}`]);
  assert.equal(second.waiting[0].commit, first.waiting[0].commit, 'the same change on the same tip is the same commit');
  assert.deepEqual([first.waiting[0].created, second.waiting[0].created], [true, false]);
  assert.equal([...first.waiting, ...second.waiting].filter(w => w.would_open).length, 1);
  assert.equal(second.gap, undefined, 'a run that created no branch names no pull request to open');
});

test('every ref but a sync/upstream branch is refused before git starts, and the remote keeps every ref', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project, at } = await projectWith(up, ['greet']);
  const commit = git(project, 'rev-parse', 'HEAD');
  const before = refsOf(at.repo);
  for (const ref of ['refs/heads/main', 'refs/heads/deploy', 'main', 'refs/heads/sync/a-project/greet', 'refs/heads/sync/upstream/greet',
    'refs/heads/sync/upstream/greet/not-a-commit', `refs/heads/sync/upstream/../main/${commit}`, `refs/heads/sync/upstream/greet/${commit}/more`,
    `refs/tags/sync/upstream/greet/${commit}`, `refs/heads/sync/upstream/Greet/${commit}`, `+refs/heads/sync/upstream/greet/${commit}`]) {
    assert.throws(() => pushSyncBranch(project, at.repo, commit, ref), RefRefused, ref);
  }
  assert.throws(() => pushSyncBranch(project, at.repo, 'HEAD', syncRef('greet', commit)), RefRefused, 'only a full commit id is pushed');
  assert.deepEqual(refsOf(at.repo), before);
  assert.deepEqual(pushSyncBranch(project, at.repo, commit, syncRef('greet', commit)), { created: true });
  assert.deepEqual(pushSyncBranch(project, at.repo, commit, syncRef('greet', commit)), { created: false });
});

test('a pointer\'s paths bound upstream: a file outside them is never brought, and a dropped file is never added again', async () => {
  const up = makeUpstream({ ...toolFiles('greet'), 'tools/greet/do-work/extra.mjs': 'extra\n', 'tools/greet/do-work/kept.mjs': 'kept\n' });
  const registry0 = await projectWith(up, ['greet']);
  // The project took only the paths its pointer names, as a project takes only the files it loads.
  const paths = ['what-this-tool-does-and-how-to-run-it.json', 'do-work/run.mjs', 'do-work/kept.mjs'];
  const { registry, clones } = registry0;
  pathsRegistry(registry, up, 'greet', paths);
  const { project, at } = registry0;
  const { add } = await import('../../add-a-tool-to-a-project/do-work/add.ts');
  rmSync(join(project, TOOLS_FOLDER), { recursive: true, force: true });
  const added = await add({ project, tool: 'greet', from: registry, prepare: false });
  assert.deepEqual(added.refused, []);
  publish(project, 'greet by its paths');
  // Upstream changes a file outside the paths and one inside; the pointer moves with the same paths.
  const next = commitUpstream(up, { 'tools/greet/do-work/extra.mjs': 'extra, changed\n', 'tools/greet/do-work/run.mjs': TEXT.replace('one', 'uno') });
  pathsRegistry(registry, up, 'greet', paths, next);
  const planned = await plan({ ...at, clones });
  assert.deepEqual(Object.keys(planned.tools.greet.files).sort(), [...paths].sort(), 'only the pointer\'s paths are compared');
  const done = await apply({ ...at, clones, plan: planned });
  const branch = done.waiting[0].branch;
  assert.throws(() => show(at.repo, `${branch}:${TOOLS_FOLDER}/greet/do-work/extra.mjs`), 'a file outside the paths is never brought');
  // The pointer drops kept.mjs: it goes on the branch and is not added back; the project dropped nothing else.
  const later = commitUpstream(up, { 'tools/greet/do-work/kept.mjs': 'kept, changed upstream\n' });
  pathsRegistry(registry, up, 'greet', paths.filter(path => path !== 'do-work/kept.mjs'), later);
  const trimmed = await plan({ ...at, clones });
  assert.equal(trimmed.tools.greet.files['do-work/kept.mjs'], 'deleted-upstream');
  const after = await apply({ ...at, clones, plan: trimmed });
  const trimmedBranch = after.waiting[0].branch;
  assert.throws(() => show(at.repo, `${trimmedBranch}:${TOOLS_FOLDER}/greet/do-work/kept.mjs`), 'the dropped file is not on the branch');
  assert.equal(recordAt(at.repo, trimmedBranch).tools.greet.files['do-work/kept.mjs'], undefined);
});

test('a file the project dropped stays dropped: it is the project\'s own change, and nothing is pushed for it', async () => {
  const up = makeUpstream({ ...toolFiles('greet'), 'tools/greet/do-work/extra.mjs': 'extra\n' });
  const { project, clones, at } = await projectWith(up, ['greet']);
  rmSync(join(project, TOOLS_FOLDER, 'greet', 'do-work', 'extra.mjs'));
  publish(project, 'the project drops extra.mjs');
  const before = refsOf(at.repo);
  const planned = await plan({ ...at, clones });
  assert.equal(planned.tools.greet.state, 'project-only');
  assert.equal(planned.tools.greet.files['do-work/extra.mjs'], 'deleted-project');
  const done = await apply({ ...at, clones, plan: planned });
  assert.deepEqual([done.project_only, done.waiting], [['greet'], []]);
  assert.deepEqual(refsOf(at.repo), before, 'a project change is never pushed anywhere');
});

test('a both-clean merge waits on its branch holding both sides, and main never moves', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project, registry, clones, at } = await projectWith(up, ['greet']);
  writeFileSync(join(project, TOOLS_FOLDER, 'greet', 'do-work', 'run.mjs'), TEXT.replace('one', 'ONE'));
  publish(project);
  const main = refsOf(at.repo)[MAIN];
  commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('six', 'SIX') });
  writeRegistry(registry, up, ['greet']);
  const planned = await plan({ ...at, clones });
  assert.equal(planned.tools.greet.state, 'both-clean');
  const done = await apply({ ...at, clones, plan: planned });
  assert.equal(show(at.repo, `${done.waiting[0].branch}:${TOOLS_FOLDER}/greet/do-work/run.mjs`), TEXT.replace('one', 'ONE').replace('six', 'SIX'));
  assert.equal(refsOf(at.repo)[MAIN], main);
});
