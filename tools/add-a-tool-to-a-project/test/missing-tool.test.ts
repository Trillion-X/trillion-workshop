// 6. A name the registry does not hold is not-in-registry; a pointer whose folder is not in its commit is
// tool-not-found-at-commit; neither writes anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../do-work/add.ts';
import { emptyProject, makeRegistry, makeRepo, scratch, standInTool } from './fixtures.ts';

test('a missing tool is refused by why, and nothing is written', async () => {
  const { repo, commit } = makeRepo(standInTool('greet'));
  const registry = makeRegistry(repo, commit, { greet: [] });
  const project = emptyProject();
  const absent = await add({ project, tool: 'wave', from: registry });
  assert.deepEqual(absent.refused.map(r => r.why), ['not-in-registry']);
  const elsewhere = scratch('registry-elsewhere');
  writeFileSync(join(elsewhere, 'tools-in-this-registry.json'), JSON.stringify({ tools: { wave: {
    repo, path: 'tools/wave', commit, files_blake3: 'b'.repeat(64), what_it_does: 'Not in the commit.', needs_tools: [] } } }));
  const notThere = await add({ project, tool: 'wave', from: elsewhere });
  assert.deepEqual(notThere.refused.map(r => r.why), ['tool-not-found-at-commit']);
  assert.equal(existsSync(join(project, 'trillion')), false);
});
