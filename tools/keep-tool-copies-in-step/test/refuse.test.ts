// Adversarial: a conflict pushes nothing and leaves every branch of the project's remote as it was, files that would
// have merged cleanly included; a fork (synced: false) is never read about (a fetch stand-in that throws is never called);
// a record or file changed on the project between plan and apply refuses and pushes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECORD_FILE } from '../../add-a-tool-to-a-project/read-data/record.ts';
import { apply, plan, realIo, type Io } from '../do-work/sync.ts';
import { TEXT, commitUpstream, makeUpstream, projectWith, publish, refsOf, toolFiles, writeRegistry, PLACE } from './fixtures.ts';

const recordOf = (project: string) => join(project, PLACE, RECORD_FILE);

test('a conflict is refused with a unified diff and no branch of the project remote moves', async () => {
  const up = makeUpstream({ ...toolFiles('greet'), 'tools/greet/do-work/other.mjs': TEXT });
  const { project, registry, clones, at } = await projectWith(up, ['greet']);
  const tool = join(project, PLACE, 'greet', 'do-work');
  writeFileSync(join(tool, 'run.mjs'), TEXT.replace('one', 'ONE'));
  writeFileSync(join(tool, 'other.mjs'), TEXT.replace('one', 'ONE'));
  publish(project);
  commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('one', 'uno'), 'tools/greet/do-work/other.mjs': TEXT.replace('six', 'SIX') });
  writeRegistry(registry, up, ['greet']);
  const before = refsOf(at.repo);
  const planned = await plan({ ...at, clones });
  assert.equal(planned.tools.greet.state, 'both-conflict');
  assert.deepEqual(planned.tools.greet.files, {
    'do-work/other.mjs': 'both-clean', 'do-work/run.mjs': 'both-conflict', 'what-this-tool-does-and-how-to-run-it.json': 'same' });
  const done = await apply({ ...at, clones, plan: planned });
  assert.deepEqual(done.waiting, []);
  assert.deepEqual(done.conflicts.map(c => [c.tool, c.path]), [['greet', 'do-work/run.mjs']]);
  assert.match(done.conflicts[0].diff, /^\+\+\+ project\/do-work\/run\.mjs$/m);
  assert.match(done.conflicts[0].diff, /^\+ONE$/m);
  assert.match(done.conflicts[0].diff, /^\+uno$/m);
  assert.doesNotMatch(done.conflicts[0].diff, /^<<<<<<< /m, 'no conflict markers are handed back');
  assert.deepEqual(refsOf(at.repo), before, 'no branch was made or moved, the clean file included');
});

test('a fork makes no network call and is reported as forked', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project, clones, at } = await projectWith(up, ['greet']);
  const record = JSON.parse(readFileSync(recordOf(project), 'utf8'));
  record.tools.greet.synced = false;
  writeFileSync(recordOf(project), `${JSON.stringify(record, null, 2)}\n`);
  publish(project);
  const refuse = () => { throw new Error('a fork reached out'); };
  const io: Io = { fetchCommit: refuse, readRegistry: async () => refuse(), remoteHead: refuse };
  const planned = await plan({ ...at, clones }, io);
  assert.equal(planned.tools.greet.state, 'forked');
  const before = refsOf(at.repo);
  const done = await apply({ ...at, clones, plan: planned }, io);
  assert.deepEqual(done.forked, ['greet']);
  assert.deepEqual(refsOf(at.repo), before);
});

test('a record changed between plan and apply refuses the apply and pushes nothing', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project, registry, clones, at } = await projectWith(up, ['greet']);
  commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('six', 'SIX') });
  writeRegistry(registry, up, ['greet']);
  const planned = await plan({ ...at, clones });
  assert.equal(planned.tools.greet.state, 'upstream-only');
  writeFileSync(recordOf(project), readFileSync(recordOf(project), 'utf8').replace('"synced": true', '"synced": true '));
  publish(project);
  const before = refsOf(at.repo);
  const done = await apply({ ...at, clones, plan: planned }, realIo(clones));
  assert.deepEqual(done.refused.map(r => [r.tool, r.why]), [['greet', 'record-changed-meanwhile']]);
  assert.deepEqual(done.waiting, []);
  assert.deepEqual(refsOf(at.repo), before);
});

test('a file edited between plan and apply refuses the tool and pushes nothing', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project, registry, clones, at } = await projectWith(up, ['greet']);
  commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('six', 'SIX') });
  writeRegistry(registry, up, ['greet']);
  const planned = await plan({ ...at, clones });
  writeFileSync(join(project, PLACE, 'greet', 'do-work', 'run.mjs'), TEXT.replace('one', 'ONE'));
  publish(project);
  const before = refsOf(at.repo);
  const done = await apply({ ...at, clones, plan: planned });
  assert.deepEqual(done.refused.map(r => [r.tool, r.why]), [['greet', 'changed-since-plan']]);
  assert.deepEqual(refsOf(at.repo), before);
});

test('a record line written before registries were recorded by address names the one-time rewrite when its path cannot be read', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project, registry, at } = await projectWith(up, ['greet']);
  const record = JSON.parse(readFileSync(recordOf(project), 'utf8'));
  // The old shape: a folder path in from.registry, of a folder with no origin (as an old record's copy is on another computer).
  const bare = join(registry, '..', `${registry.split('/').pop()}-no-origin`);
  mkdirSync(bare);
  writeFileSync(join(bare, 'tools-in-this-registry.json'), readFileSync(join(registry, 'tools-in-this-registry.json')));
  record.tools.greet.from.registry = bare;
  writeFileSync(recordOf(project), `${JSON.stringify(record, null, 2)}\n`);
  publish(project);
  const planned = await plan(at);
  assert.equal(planned.tools.greet.state, 'refused');
  assert.equal(planned.tools.greet.why, 'bad-from');
  assert.match(planned.tools.greet.said!, /rewrite its registry fields once to the registry's address/);
});
