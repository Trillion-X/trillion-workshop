// Integration, against a local bare upstream: an upstream-only commit updates the project's folder and advances its record
// line; a project-only edit is offered upstream as branch sync/<project>/<tool> pushed with --force-with-lease, and offering
// it again pushes nothing; edits on both sides of one file that git merges are written to both sides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileDigest } from '../../content-identity/read-data/manifest.mjs';
import { RECORD_FILE, TOOLS_FOLDER } from '../../add-a-tool-to-a-project/read-data/record.ts';
import { apply, plan } from '../do-work/sync.ts';
import { TEXT, commitUpstream, git, makeUpstream, projectWith, toolFiles, writeRegistry } from './fixtures.ts';

const record = (project: string) => JSON.parse(readFileSync(join(project, TOOLS_FOLDER, RECORD_FILE), 'utf8'));
const branchOf = (project: string, tool: string) => `sync/${basename(project).toLowerCase()}/${tool}`;

test('an upstream-only commit updates the folder, deletes what upstream deleted, and advances the record', async () => {
  const up = makeUpstream({ ...toolFiles('greet'), 'tools/greet/do-work/gone.mjs': 'old\n', 'tools/other/x.mjs': 'x\n' });
  const { project, registry } = await projectWith(up, ['greet']);
  const first = up.commit;
  const next = commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('six', 'SIX'), 'tools/greet/do-work/gone.mjs': null,
    'tools/greet/do-work/new.mjs': 'new\n' });
  writeRegistry(registry, up, ['greet']);
  const planned = await plan({ project, fact: { where: 'github:registry', place: 'refs/heads/main', key: next } });
  assert.equal(planned.tools.greet.state, 'upstream-only');
  assert.deepEqual(planned.because, { where: 'github:registry', place: 'refs/heads/main', key: next });
  const done = await apply({ project, plan: planned });
  assert.deepEqual(done.settled, ['greet']);
  assert.deepEqual(done.pushed, []);
  const folder = join(project, TOOLS_FOLDER, 'greet', 'do-work');
  assert.equal(readFileSync(join(folder, 'run.mjs'), 'utf8'), TEXT.replace('six', 'SIX'));
  assert.equal(readFileSync(join(folder, 'new.mjs'), 'utf8'), 'new\n');
  assert.equal(existsSync(join(folder, 'gone.mjs')), false);
  const line = record(project).tools.greet;
  assert.notEqual(next, first);
  assert.equal(line.copied_at_commit, next);
  assert.equal(line.files['do-work/run.mjs'], fileDigest(Buffer.from(TEXT.replace('six', 'SIX'))));
  assert.equal(line.files['do-work/gone.mjs'], undefined);
  const again = await apply({ project, plan: await plan({ project }) });
  assert.deepEqual(again.unchanged, ['greet'], 'a second sync finds nothing to do');
});

test('a project-only edit is pushed upstream as a sync branch with a lease, and offering it again pushes nothing', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project } = await projectWith(up, ['greet']);
  writeFileSync(join(project, TOOLS_FOLDER, 'greet', 'do-work', 'run.mjs'), TEXT.replace('one', 'ONE'));
  const recordBefore = readFileSync(join(project, TOOLS_FOLDER, RECORD_FILE));
  const planned = await plan({ project });
  assert.equal(planned.tools.greet.state, 'project-only');
  const done = await apply({ project, plan: planned });
  const branch = branchOf(project, 'greet');
  assert.deepEqual(done.pushed.map(p => [p.tool, p.branch, p.already]), [['greet', branch, false]]);
  assert.deepEqual(readFileSync(join(project, TOOLS_FOLDER, RECORD_FILE)), recordBefore, 'the record does not move');
  assert.equal(git(up.bare, 'rev-parse', `refs/heads/${branch}`), done.pushed[0].commit);
  assert.equal(git(up.bare, 'rev-parse', `${done.pushed[0].commit}^`), up.commit, 'made on the upstream commit');
  assert.equal(git(up.bare, 'show', `${branch}:tools/greet/do-work/run.mjs`), TEXT.replace('one', 'ONE').trimEnd());
  assert.equal(git(up.bare, 'rev-parse', 'refs/heads/main'), up.commit, 'main is never pushed');
  const again = await apply({ project, plan: await plan({ project }) });
  assert.deepEqual(again.pushed.map(p => [p.branch, p.already, p.commit]), [[branch, true, done.pushed[0].commit]]);
});

test('both sides edit one file and git merges it: the merge is written to the project and offered upstream', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project, registry } = await projectWith(up, ['greet']);
  writeFileSync(join(project, TOOLS_FOLDER, 'greet', 'do-work', 'run.mjs'), TEXT.replace('one', 'ONE'));
  commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('six', 'SIX') });
  writeRegistry(registry, up, ['greet']);
  const planned = await plan({ project });
  assert.equal(planned.tools.greet.state, 'both-clean');
  const done = await apply({ project, plan: planned });
  const merged = TEXT.replace('one', 'ONE').replace('six', 'SIX');
  assert.deepEqual(done.settled, ['greet']);
  assert.equal(readFileSync(join(project, TOOLS_FOLDER, 'greet', 'do-work', 'run.mjs'), 'utf8'), merged);
  assert.equal(record(project).tools.greet.copied_at_commit, up.commit);
  assert.equal(git(up.bare, 'show', `${done.pushed[0].branch}:tools/greet/do-work/run.mjs`), merged.trimEnd());
});

test('a local clone holding the commits is read when the upstream cannot be reached, and the offer upstream is refused by name', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project, registry } = await projectWith(up, ['greet']);
  writeFileSync(join(project, TOOLS_FOLDER, 'greet', 'do-work', 'run.mjs'), TEXT.replace('one', 'ONE'));
  commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('six', 'SIX') });
  writeRegistry(registry, up, ['greet']);
  // The registry now names an address nothing answers; the work clone holds both commits.
  const pointers = JSON.parse(readFileSync(join(registry, 'tools-in-this-registry.json'), 'utf8'));
  pointers.tools.greet.repo = join(up.bare, 'gone');
  writeFileSync(join(registry, 'tools-in-this-registry.json'), `${JSON.stringify(pointers, null, 2)}\n`);
  const planned = await plan({ project, clones: [up.work] });
  assert.equal(planned.tools.greet.state, 'both-clean');
  const done = await apply({ project, plan: planned, clones: [up.work] });
  assert.deepEqual(done.settled, ['greet']);
  assert.equal(readFileSync(join(project, TOOLS_FOLDER, 'greet', 'do-work', 'run.mjs'), 'utf8'), TEXT.replace('one', 'ONE').replace('six', 'SIX'));
  assert.deepEqual(done.refused.map(r => [r.tool, r.why]), [['greet', 'push-refused']]);
  assert.deepEqual(done.pushed, []);
});
