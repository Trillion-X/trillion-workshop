// A folder whose card still has the old name (tool-rows.json) is refused as old-card-name, naming the folder, and nothing
// is written: the add tool reads only what-this-tool-does-and-how-to-run-it.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../do-work/add.ts';
import { emptyProject, makeRegistry, makeRepo } from './fixtures.ts';

test('a folder with only the old card name is refused, naming the folder', async () => {
  const { repo, commit } = makeRepo({
    'tools/greet/tool-rows.json': '{"records":[],"prepare":["node","-e","1"]}\n',
    'tools/greet/do-work/x.mjs': 'export const name = "greet";\n',
  });
  const project = emptyProject();
  const output = await add({ project, tool: 'greet', from: makeRegistry(repo, commit, { greet: [] }) });
  assert.deepEqual(output.refused.map(r => r.why), ['old-card-name']);
  assert.match(output.refused[0].said, /^tools\/greet: its card has the old name tool-rows\.json/);
  assert.deepEqual(output.added, []);
  assert.equal(existsSync(join(project, 'trillion')), false);
});
