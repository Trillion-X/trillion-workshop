// 2. Adding the same tool again writes nothing: it is `already`, and the record file's bytes are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../do-work/add.ts';
import { fileDigest } from '../../content-identity/read-data/manifest.mjs';
import { emptyProject, makeRegistry, makeRepo, standInTool } from './fixtures.ts';

test('adding a tool the project already holds unchanged writes nothing', async () => {
  const { repo, commit } = makeRepo(standInTool('greet'));
  const registry = makeRegistry(repo, commit, { greet: [] });
  const project = emptyProject();
  await add({ project, tool: 'greet', from: registry });
  const recordFile = join(project, 'trillion', 'where-each-tool-comes-from.json');
  const before = fileDigest(readFileSync(recordFile));
  const again = await add({ project, tool: 'greet' });
  assert.deepEqual(again, { added: [], already: ['greet'], refused: [], prepared: [], not_prepared: [] });
  assert.equal(fileDigest(readFileSync(recordFile)), before);
});
