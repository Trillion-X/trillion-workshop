// Adversarial: a conflict leaves the project byte for byte as it was (the BLAKE3 of every file of the folder and of the
// record, before == after), files that would have merged cleanly included; a fork (synced: false) is never read about (a
// fetch stand-in that throws is never called); a record changed between plan and apply refuses the apply and writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileDigest, identityOfDigests } from '../../content-identity/read-data/manifest.mjs';
import { RECORD_FILE, TOOLS_FOLDER } from '../../add-a-tool-to-a-project/read-data/record.ts';
import { apply, plan, realIo, type Io } from '../do-work/sync.ts';
import { TEXT, commitUpstream, makeUpstream, projectWith, toolFiles, writeRegistry } from './fixtures.ts';

/** The identity of every file under `folder` (the .git folder left out). */
function folderIdentity(folder: string): string {
  const digests: Array<[string, string]> = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.name === '.git') continue;
      if (entry.isDirectory()) walk(full); else digests.push([relative(folder, full), fileDigest(readFileSync(full))]);
    }
  };
  walk(folder);
  return identityOfDigests(digests);
}

test('a conflict is refused with a unified diff and the project folder is unchanged', async () => {
  const up = makeUpstream({ ...toolFiles('greet'), 'tools/greet/do-work/other.mjs': TEXT });
  const { project, registry } = await projectWith(up, ['greet']);
  const tool = join(project, TOOLS_FOLDER, 'greet', 'do-work');
  writeFileSync(join(tool, 'run.mjs'), TEXT.replace('one', 'ONE'));
  writeFileSync(join(tool, 'other.mjs'), TEXT.replace('one', 'ONE'));
  commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('one', 'uno'), 'tools/greet/do-work/other.mjs': TEXT.replace('six', 'SIX') });
  writeRegistry(registry, up, ['greet']);
  const before = folderIdentity(project);
  const planned = await plan({ project });
  assert.equal(planned.tools.greet.state, 'both-conflict');
  assert.deepEqual(planned.tools.greet.files, {
    'do-work/other.mjs': 'both-clean', 'do-work/run.mjs': 'both-conflict', 'what-this-tool-does-and-how-to-run-it.json': 'same' });
  const done = await apply({ project, plan: planned });
  assert.deepEqual(done.settled, []);
  assert.deepEqual(done.conflicts.map(c => [c.tool, c.path]), [['greet', 'do-work/run.mjs']]);
  assert.match(done.conflicts[0].diff, /^\+\+\+ project\/do-work\/run\.mjs$/m);
  assert.match(done.conflicts[0].diff, /^\+ONE$/m);
  assert.match(done.conflicts[0].diff, /^\+uno$/m);
  assert.doesNotMatch(done.conflicts[0].diff, /^<<<<<<< /m, 'no conflict markers are handed back');
  assert.equal(folderIdentity(project), before, 'nothing in the project moved, the clean file included');
});

test('a fork makes no network call and is reported as forked', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project } = await projectWith(up, ['greet']);
  const recordFile = join(project, TOOLS_FOLDER, RECORD_FILE);
  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  record.tools.greet.synced = false;
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  const refuse = () => { throw new Error('a fork reached out'); };
  const io: Io = { fetchCommit: refuse, readRegistry: async () => refuse(), remoteHead: refuse };
  const planned = await plan({ project }, io);
  assert.equal(planned.tools.greet.state, 'forked');
  const before = folderIdentity(project);
  const done = await apply({ project, plan: planned }, io);
  assert.deepEqual(done.forked, ['greet']);
  assert.equal(folderIdentity(project), before);
});

test('a record changed between plan and apply refuses the apply and writes nothing', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project, registry } = await projectWith(up, ['greet']);
  commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('six', 'SIX') });
  writeRegistry(registry, up, ['greet']);
  const planned = await plan({ project });
  assert.equal(planned.tools.greet.state, 'upstream-only');
  const recordFile = join(project, TOOLS_FOLDER, RECORD_FILE);
  writeFileSync(recordFile, readFileSync(recordFile, 'utf8').replace('"synced": true', '"synced": true '));
  const before = folderIdentity(project);
  const done = await apply({ project, plan: planned }, realIo());
  assert.deepEqual(done.refused.map(r => [r.tool, r.why]), [['greet', 'record-changed-meanwhile']]);
  assert.deepEqual(done.settled, []);
  assert.equal(folderIdentity(project), before);
});

test('a file edited between plan and apply refuses the tool and writes nothing', async () => {
  const up = makeUpstream(toolFiles('greet'));
  const { project, registry } = await projectWith(up, ['greet']);
  commitUpstream(up, { 'tools/greet/do-work/run.mjs': TEXT.replace('six', 'SIX') });
  writeRegistry(registry, up, ['greet']);
  const planned = await plan({ project });
  writeFileSync(join(project, TOOLS_FOLDER, 'greet', 'do-work', 'run.mjs'), TEXT.replace('one', 'ONE'));
  const before = folderIdentity(project);
  const done = await apply({ project, plan: planned });
  assert.deepEqual(done.refused.map(r => [r.tool, r.why]), [['greet', 'changed-since-plan']]);
  assert.equal(folderIdentity(project), before);
});
