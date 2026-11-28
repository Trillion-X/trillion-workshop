// Plan 30.3: a change in a needed tool is an upstream change of the tool that needs it (its closure_blake3 is compared with
// the same identity over the upstream versions), and a record line whose files do not hash to its copied_at_files_blake3
// is a hand edit, reported as local-edit and never used as the version a copy started from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECORD_FILE, TOOLS_FOLDER } from '../../add-a-tool-to-a-project/read-data/record.ts';
import { add } from '../../add-a-tool-to-a-project/do-work/add.ts';
import { emptyProject, pinOf, scratch, withOrigin } from '../../add-a-tool-to-a-project/test/fixtures.ts';
import { apply, plan, type Io } from '../do-work/sync.ts';
import { TEXT, commitUpstream, git, makeUpstream, projectWith, publish, refsOf, remoteOf, toolFiles, type Upstream } from './fixtures.ts';

const recordFile = (project: string) => join(project, TOOLS_FOLDER, RECORD_FILE);
const record = (project: string) => JSON.parse(readFileSync(recordFile(project), 'utf8'));

/** A registry where app needs base, each pointer at its own commit. */
function needsRegistry(registry: string, up: Upstream, commits: { app: string; base: string }, repo: string): void {
  const pointer = (name: 'app' | 'base', needs: string[]) => ({ repo, path: `tools/${name}`, commit: commits[name],
    files_blake3: pinOf(up.work, commits[name], `tools/${name}`), what_it_does: `The stand-in ${name}.`, needs_tools: needs });
  writeFileSync(join(registry, 'tools-in-this-registry.json'),
    `${JSON.stringify({ _what: 'A stand-in registry.', tools: { app: pointer('app', ['base']), base: pointer('base', []) } }, null, 2)}\n`);
}

/** A git project holding app and the base it needs, copied by the add tool; then base alone changes upstream, and the
 *  registry names `repo` as where both come from. */
async function baseMoved() {
  const up = makeUpstream({ ...toolFiles('app'), ...toolFiles('base') });
  const first = up.commit;
  const registry = scratch('registry');
  needsRegistry(registry, up, { app: first, base: first }, up.bare);
  withOrigin(registry);
  const project = emptyProject();
  const added = await add({ project, tool: 'app', from: registry, prepare: false });
  assert.deepEqual(added.refused, []);
  git(project, 'init', '-q');
  git(project, 'add', '-A');
  git(project, '-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-m', 'tools copied');
  const at = remoteOf(project);
  const next = commitUpstream(up, { 'tools/base/do-work/run.mjs': TEXT.replace('two', 'TWO') });
  needsRegistry(registry, up, { app: first, base: next }, up.bare);
  return { up, project, registry, clones: [up.work, registry], first, next, at };
}

test('a change in a needed tool alone makes the tool that needs it upstream-only, and it waits on the needed tool\'s branch', async () => {
  const { project, clones, first, next, at } = await baseMoved();
  const recorded = record(project).tools.app.closure_blake3;
  const main = refsOf(at.repo)['refs/heads/main'];
  const planned = await plan({ ...at, clones });
  assert.equal(planned.tools.base.state, 'upstream-only');
  assert.equal(planned.tools.app.state, 'upstream-only', 'app\'s own files did not move, its closure did');
  assert.deepEqual(Object.values(planned.tools.app.files).filter(v => v !== 'same'), []);
  assert.equal(planned.tools.app.upstream_commit, first);
  assert.equal(planned.tools.app.closure!.recorded, recorded);
  assert.notEqual(planned.tools.app.closure!.upstream, recorded);
  const done = await apply({ ...at, clones, plan: planned });
  assert.deepEqual(done.waiting.map(w => [w.tools, w.branch, w.created]), [[['base', 'app'], `sync/upstream/base/${next}`, true]]);
  const onBranch = JSON.parse(execFileSync('git', ['-C', at.repo, 'show', `sync/upstream/base/${next}:${TOOLS_FOLDER}/${RECORD_FILE}`], { encoding: 'utf8' }));
  assert.equal(onBranch.tools.app.closure_blake3, planned.tools.app.closure!.upstream, 'the branch carries the closure the plan named');
  assert.equal(refsOf(at.repo)['refs/heads/main'], main, 'main did not move');
});

test('read at its branch, the change finds app and base in step: the branch is what merging it would make', async () => {
  const { clones, next, at } = await baseMoved();
  const planned = await plan({ ...at, clones });
  await apply({ ...at, clones, plan: planned });
  const onBranch = await plan({ ...at, clones, branch: `sync/upstream/base/${next}` });
  assert.equal(onBranch.tools.app.state, 'none-changed');
  assert.equal(onBranch.tools.app.closure, undefined);
  assert.equal(onBranch.tools.base.state, 'none-changed');
});

test('a tool whose needed tool cannot settle is refused as needs-not-settled, and nothing moves', async () => {
  const { project, clones, at } = await baseMoved();
  const edited = record(project);
  edited.tools.base.files['do-work/run.mjs'] = '0'.repeat(64);
  writeFileSync(recordFile(project), `${JSON.stringify(edited, null, 2)}\n`);
  publish(project, 'record edited');
  const before = refsOf(at.repo);
  const planned = await plan({ ...at, clones });
  assert.equal(planned.tools.base.state, 'local-edit');
  assert.equal(planned.tools.app.state, 'upstream-only');
  const done = await apply({ ...at, clones, plan: planned });
  assert.deepEqual(done.refused.map(r => [r.tool, r.why]).sort(), [['app', 'needs-not-settled'], ['base', 'local-edit']]);
  assert.deepEqual(done.waiting, []);
  assert.deepEqual(refsOf(at.repo), before);
});

test('a hand-edited record line is reported as local-edit before any network call, and is never a start version', async () => {
  for (const edit of [
    (line: Record<string, any>) => { line.files['do-work/run.mjs'] = 'f'.repeat(64); },
    (line: Record<string, any>) => { line.files['do-work/extra.mjs'] = 'a'.repeat(64); },
    (line: Record<string, any>) => { delete line.files['do-work/run.mjs']; },
    (line: Record<string, any>) => { line.copied_at_files_blake3 = 'b'.repeat(64); },
  ]) {
    const up = makeUpstream(toolFiles('greet'));
    const { project, clones, at } = await projectWith(up, ['greet']);
    const edited = record(project);
    edit(edited.tools.greet);
    writeFileSync(recordFile(project), `${JSON.stringify(edited, null, 2)}\n`);
    publish(project, 'record edited');
    const before = refsOf(at.repo);
    const refuse = () => { throw new Error('a local-edit line reached out'); };
    const io: Io = { fetchCommit: refuse, readRegistry: async () => refuse(), remoteHead: refuse };
    const planned = await plan({ ...at, clones }, io);
    assert.equal(planned.tools.greet.state, 'local-edit');
    assert.equal(planned.tools.greet.why, 'local-edit');
    assert.match(planned.tools.greet.said!, /edited by hand/);
    const done = await apply({ ...at, clones, plan: planned }, io);
    assert.deepEqual(done.refused.map(r => [r.tool, r.why]), [['greet', 'local-edit']]);
    assert.deepEqual([done.waiting, done.project_only, done.conflicts], [[], [], []]);
    assert.deepEqual(refsOf(at.repo), before, 'nothing is pushed, the record is not rewritten');
  }
});
