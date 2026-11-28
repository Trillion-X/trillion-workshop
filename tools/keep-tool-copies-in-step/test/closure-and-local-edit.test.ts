// Plan 30.3: a change in a needed tool is an upstream change of the tool that needs it (its closure_blake3 is compared with
// the same identity over the upstream versions), and a record line whose files do not hash to its copied_at_files_blake3
// is a hand edit, reported as local-edit and never used as the version a copy started from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECORD_FILE, TOOLS_FOLDER } from '../../add-a-tool-to-a-project/read-data/record.ts';
import { add } from '../../add-a-tool-to-a-project/do-work/add.ts';
import { emptyProject, pinOf, scratch, withOrigin } from '../../add-a-tool-to-a-project/test/fixtures.ts';
import { apply, plan, type Io } from '../do-work/sync.ts';
import { GREEN, OWNED, TEXT, commitUpstream, git, makeUpstream, projectWith, setRecord, toolFiles, type Upstream } from './fixtures.ts';

const recordFile = (project: string) => join(project, TOOLS_FOLDER, RECORD_FILE);
const record = (project: string) => JSON.parse(readFileSync(recordFile(project), 'utf8'));
const commitRecord = (project: string) => git(project, '-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-am', 'record edited');

/** A registry where app needs base, each pointer at its own commit. */
function needsRegistry(registry: string, up: Upstream, commits: { app: string; base: string }, repo: string): void {
  const pointer = (name: 'app' | 'base', needs: string[]) => ({ repo, path: `tools/${name}`, commit: commits[name],
    files_blake3: pinOf(up.work, commits[name], `tools/${name}`), what_it_does: `The stand-in ${name}.`, needs_tools: needs });
  writeFileSync(join(registry, 'tools-in-this-registry.json'),
    `${JSON.stringify({ _what: 'A stand-in registry.', tools: { app: pointer('app', ['base']), base: pointer('base', []) } }, null, 2)}\n`);
}

/** A git project holding app and the base it needs, copied by the add tool; then base alone changes upstream, and the
 *  registry names `repo` as where both come from. */
async function baseMoved(repo: (up: Upstream) => string) {
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
  const next = commitUpstream(up, { 'tools/base/do-work/run.mjs': TEXT.replace('two', 'TWO') });
  needsRegistry(registry, up, { app: first, base: next }, repo(up));
  return { up, project, registry, clones: [up.work, registry], first, next };
}

test('a change in a needed tool alone makes the tool that needs it upstream-only, and it waits on the needed tool\'s branch', async () => {
  const { project, clones, first } = await baseMoved(up => up.bare);
  const recorded = record(project).tools.app.closure_blake3;
  const planned = await plan({ project, clones });
  assert.equal(planned.tools.base.state, 'upstream-only');
  assert.equal(planned.tools.app.state, 'upstream-only', 'app\'s own files did not move, its closure did');
  assert.deepEqual(Object.values(planned.tools.app.files).filter(v => v !== 'same'), []);
  assert.equal(planned.tools.app.upstream_commit, first);
  assert.equal(planned.tools.app.closure!.recorded, recorded);
  assert.notEqual(planned.tools.app.closure!.upstream, recorded);
  const done = await apply({ project, clones, plan: planned });
  assert.deepEqual(done.waiting.map(w => [w.tools, w.branch, w.why]), [[['base', 'app'], 'sync/upstream/base', 'not-trusted']]);
  const onBranch = JSON.parse(git(project, 'show', `sync/upstream/base:${TOOLS_FOLDER}/${RECORD_FILE}`));
  assert.equal(onBranch.tools.app.closure_blake3, planned.tools.app.closure!.upstream, 'the branch carries the closure the plan named');
  assert.equal(record(project).tools.app.closure_blake3, recorded, 'the project HEAD did not move');
});

test('from a trusted source both settle in one commit, and the next plan finds app in step', async () => {
  const { project, clones } = await baseMoved(() => OWNED);
  setRecord(project, { trust: ['example-owner'], test: GREEN });
  const planned = await plan({ project, clones });
  const done = await apply({ project, clones, plan: planned });
  assert.deepEqual([...done.settled].sort(), ['app', 'base']);
  assert.equal(record(project).tools.app.closure_blake3, planned.tools.app.closure!.upstream);
  const again = await plan({ project, clones });
  assert.equal(again.tools.app.state, 'none-changed');
  assert.equal(again.tools.app.closure, undefined);
  assert.equal(again.tools.base.state, 'none-changed');
});

test('a tool whose needed tool cannot settle is refused as needs-not-settled, and nothing moves', async () => {
  const { project, clones } = await baseMoved(up => up.bare);
  const edited = record(project);
  edited.tools.base.files['do-work/run.mjs'] = '0'.repeat(64);
  writeFileSync(recordFile(project), `${JSON.stringify(edited, null, 2)}\n`);
  commitRecord(project);
  const head = git(project, 'rev-parse', 'HEAD');
  const planned = await plan({ project, clones });
  assert.equal(planned.tools.base.state, 'local-edit');
  assert.equal(planned.tools.app.state, 'upstream-only');
  const done = await apply({ project, clones, plan: planned });
  assert.deepEqual(done.refused.map(r => [r.tool, r.why]).sort(), [['app', 'needs-not-settled'], ['base', 'local-edit']]);
  assert.deepEqual(done.waiting, []);
  assert.equal(git(project, 'rev-parse', 'HEAD'), head);
});

test('a hand-edited record line is reported as local-edit before any network call, and is never a start version', async () => {
  for (const edit of [
    (line: Record<string, any>) => { line.files['do-work/run.mjs'] = 'f'.repeat(64); },
    (line: Record<string, any>) => { line.files['do-work/extra.mjs'] = 'a'.repeat(64); },
    (line: Record<string, any>) => { delete line.files['do-work/run.mjs']; },
    (line: Record<string, any>) => { line.copied_at_files_blake3 = 'b'.repeat(64); },
  ]) {
    const up = makeUpstream(toolFiles('greet'));
    const { project, clones } = await projectWith(up, ['greet']);
    const edited = record(project);
    edit(edited.tools.greet);
    writeFileSync(recordFile(project), `${JSON.stringify(edited, null, 2)}\n`);
    commitRecord(project);
    const before = readFileSync(recordFile(project));
    const refuse = () => { throw new Error('a local-edit line reached out'); };
    const io: Io = { fetchCommit: refuse, readRegistry: async () => refuse(), remoteHead: refuse };
    const planned = await plan({ project, clones }, io);
    assert.equal(planned.tools.greet.state, 'local-edit');
    assert.equal(planned.tools.greet.why, 'local-edit');
    assert.match(planned.tools.greet.said!, /edited by hand/);
    const done = await apply({ project, clones, plan: planned }, io);
    assert.deepEqual(done.refused.map(r => [r.tool, r.why]), [['greet', 'local-edit']]);
    assert.deepEqual([done.settled, done.waiting, done.pushed, done.conflicts], [[], [], [], []]);
    assert.deepEqual(readFileSync(recordFile(project)), before, 'the record is not rewritten');
  }
});
