// B2. Two sources with the same tool name: the second is refused as name-clash without `as`, and with `as` it is added
// under the folder name given, beside the first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../do-work/add.ts';
import { emptyProject, makeRegistry, makeRepo, originAddress, standInTool } from './fixtures.ts';

test('a name clash is refused without as and accepted with as', async () => {
  const first = makeRepo(standInTool('greet'));
  const second = makeRepo({ ...standInTool('greet'), 'tools/greet/do-work/y.mjs': 'export const other = true;\n' });
  const project = emptyProject();
  const added = await add({ project, tool: 'greet', from: makeRegistry(first.repo, first.commit, { greet: [] }) });
  assert.deepEqual(added.refused, []);
  const otherRegistry = makeRegistry(second.repo, second.commit, { greet: [] });
  const clash = await add({ project, tool: 'greet', from: otherRegistry });
  assert.deepEqual(clash.refused.map(r => [r.tool, r.why]), [['greet', 'name-clash']]);
  const renamed = await add({ project, tool: 'greet', from: otherRegistry, as: 'greet-from-second' });
  assert.deepEqual(renamed.refused, []);
  assert.deepEqual(renamed.added.map(a => a.tool), ['greet-from-second']);
  const record = JSON.parse(readFileSync(join(project, 'where-each-tool-comes-from.json'), 'utf8'));
  assert.deepEqual(Object.keys(record.tools).sort(), ['greet', 'greet-from-second']);
  assert.deepEqual(record.tools['greet-from-second'].from, { registry: originAddress(otherRegistry), tool: 'greet' });
  assert.equal(readFileSync(join(project, 'greet-from-second', 'do-work', 'y.mjs'), 'utf8'), 'export const other = true;\n');
});
