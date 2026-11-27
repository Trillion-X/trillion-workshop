// A needs B and B needs A (one in the registry, the other in B's card): each folder is copied once, each line names its
// needs, and both lines carry the same closure identity (each reaches the same two folders).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../do-work/add.ts';
import { emptyProject, makeRegistry, makeRepo, standInTool } from './fixtures.ts';

test('needs that loop copy each folder once', async () => {
  const { repo, commit } = makeRepo({ ...standInTool('tool-a'), ...standInTool('tool-b', { needs_tools: ['tool-a'] }) });
  const registry = makeRegistry(repo, commit, { 'tool-a': ['tool-b'], 'tool-b': [] });
  const project = emptyProject();
  const output = await add({ project, tool: 'tool-a', from: registry });
  assert.deepEqual(output.refused, []);
  assert.deepEqual(output.added.map(a => a.tool).sort(), ['tool-a', 'tool-b']);
  const record = JSON.parse(readFileSync(join(project, 'trillion', 'where-each-tool-comes-from.json'), 'utf8'));
  assert.deepEqual(record.tools['tool-a'].needs_tools, ['tool-b']);
  assert.deepEqual(record.tools['tool-b'].needs_tools, ['tool-a']);
  assert.equal(record.tools['tool-a'].closure_blake3, record.tools['tool-b'].closure_blake3);
});
