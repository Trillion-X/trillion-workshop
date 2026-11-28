// 3. Adding over an edited copy is refused with the unified diff; the edited file and the record stay as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../do-work/add.ts';
import { fileDigest } from '../../content-identity/read-data/manifest.mjs';
import { emptyProject, makeRegistry, makeRepo, standInTool } from './fixtures.ts';

test('an edited copy is refused with its diff and left untouched', async () => {
  const { repo, commit } = makeRepo(standInTool('greet'));
  const registry = makeRegistry(repo, commit, { greet: [] });
  const project = emptyProject();
  await add({ project, tool: 'greet', from: registry });
  const edited = join(project, 'greet', 'do-work', 'x.mjs');
  writeFileSync(edited, 'export const name = "greeT";\n');
  const recordFile = join(project, 'where-each-tool-comes-from.json');
  const before = fileDigest(readFileSync(recordFile));
  const output = await add({ project, tool: 'greet', from: registry });
  assert.equal(output.refused.length, 1);
  assert.equal(output.refused[0].why, 'edited-copy');
  assert.match(output.refused[0].diff!, /^-export const name = "greet";$/m);
  assert.match(output.refused[0].diff!, /^\+export const name = "greeT";$/m);
  assert.deepEqual(output.added, []);
  assert.equal(readFileSync(edited, 'utf8'), 'export const name = "greeT";\n');
  assert.equal(fileDigest(readFileSync(recordFile)), before);
});
