// A copy goes where the project's own layout wants it: `into` names the folder, the record line keeps the copy's place
// (`at`), a needed tool the record already names is found at its recorded place, and a place that climbs out of the
// project, is absolute or passes through a link is refused with nothing written. The record is the project's one record
// file, wherever it is; two are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../do-work/add.ts';
import { RECORD_FILE } from '../read-data/record.ts';
import { emptyProject, makeRegistry, makeRepo, scratch, standInTool } from './fixtures.ts';

const recordOf = (project: string, at = '') => JSON.parse(readFileSync(join(project, at, RECORD_FILE), 'utf8'));

test('a tool added into src/components/ui lives there, and its line says so', async () => {
  const { repo, commit } = makeRepo(standInTool('ui'));
  const registry = makeRegistry(repo, commit, { ui: [] });
  const project = emptyProject();
  const output = await add({ project, tool: 'ui', from: registry, into: 'src/components/ui' });
  assert.deepEqual(output.refused, []);
  assert.deepEqual(output.added.map(a => a.tool), ['ui']);
  assert.equal(readFileSync(join(project, 'src', 'components', 'ui', 'ui', 'do-work', 'x.mjs'), 'utf8'), 'export const name = "ui";\n');
  const record = recordOf(project);
  assert.equal(record.tools.ui.at, 'src/components/ui/ui');
  assert.deepEqual(output.import_map, { 'trillion-workshop/tools/ui/*': ['./src/components/ui/ui/*'] });
  assert.equal(existsSync(join(project, 'ui')), false, 'nothing is written at the default place');
});

test('a second tool that needs the first finds it at its recorded place', async () => {
  const { repo, commit } = makeRepo({ ...standInTool('ui'), ...standInTool('booking') });
  const registry = makeRegistry(repo, commit, { ui: [], booking: ['ui'] });
  const project = emptyProject();
  await add({ project, tool: 'ui', from: registry, into: 'src/components/ui' });
  const second = await add({ project, tool: 'booking', into: 'lib/tools', clones: [registry] });
  assert.deepEqual(second.refused, []);
  assert.deepEqual(second.already, ['ui']);
  assert.deepEqual(second.added.map(a => a.tool), ['booking']);
  const record = recordOf(project);
  assert.equal(record.tools.booking.at, 'lib/tools/booking');
  assert.equal(record.tools.ui.at, 'src/components/ui/ui');
  assert.deepEqual(record.tools.booking.needs_tools, ['ui']);
  assert.equal(existsSync(join(project, 'lib', 'tools', 'ui')), false, 'the needed tool is not copied a second time');
  assert.deepEqual(second.import_map, {
    'trillion-workshop/tools/booking/*': ['./lib/tools/booking/*'],
    'trillion-workshop/tools/ui/*': ['./src/components/ui/ui/*'],
  });
});

test('a place that climbs out, is absolute or passes through a link is refused, and nothing is written', async () => {
  const { repo, commit } = makeRepo(standInTool('greet'));
  const registry = makeRegistry(repo, commit, { greet: [] });
  const project = emptyProject();
  const outside = scratch('outside');
  symlinkSync(outside, join(project, 'linked'));
  for (const into of ['../outside', '/tmp/greet', 'a/../../b', 'a//b', 'linked', 'linked/deeper']) {
    const output = await add({ project, tool: 'greet', from: registry, into });
    assert.deepEqual(output.refused.map(r => r.why), ['bad-place'], into);
    assert.deepEqual(output.added, [], into);
  }
  const climbs = await add({ project, tool: 'greet', from: registry, record_at: '../elsewhere' });
  assert.deepEqual(climbs.refused.map(r => r.why), ['bad-place']);
  assert.equal(existsSync(join(project, RECORD_FILE)), false);
  assert.equal(existsSync(join(project, 'greet')), false);
  assert.equal(existsSync(join(outside, 'greet')), false);
});

test('the record is the project\'s one record file wherever it is, and two are refused', async () => {
  const { repo, commit } = makeRepo({ ...standInTool('greet'), ...standInTool('wave') });
  const registry = makeRegistry(repo, commit, { greet: [], wave: [] });
  const project = emptyProject();
  const first = await add({ project, tool: 'greet', from: registry, record_at: 'tools' });
  assert.deepEqual(first.refused, []);
  assert.equal(recordOf(project, 'tools').tools.greet.at, 'tools/greet');
  // Found again from git's list of the project's files: the next add needs no record_at, and a different one is refused.
  const second = await add({ project, tool: 'wave', clones: [registry] });
  assert.deepEqual(second.refused, []);
  assert.equal(recordOf(project, 'tools').tools.wave.at, 'tools/wave');
  const elsewhere = await add({ project, tool: 'wave', clones: [registry], record_at: 'other' });
  assert.deepEqual(elsewhere.refused.map(r => r.why), ['bad-place']);
  mkdirSync(join(project, 'other'));
  writeFileSync(join(project, 'other', RECORD_FILE), '{"tools":{}}\n');
  const two = await add({ project, tool: 'wave', clones: [registry] });
  assert.deepEqual(two.refused.map(r => r.why), ['bad-place']);
  assert.match(two.refused[0].said, /holds 2 records/);
});
