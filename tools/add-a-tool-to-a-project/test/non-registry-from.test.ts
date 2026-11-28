// 5. A direct pointer {repo, path, commit} works and is recorded as that object; a from that is not a registry (a folder
// with no registry file, or JSON of another shape) is refused as bad-from and nothing is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../do-work/add.ts';
import { emptyProject, makeRepo, originAddress, scratch, standInTool } from './fixtures.ts';

test('a direct pointer is copied and recorded as the object it was', async () => {
  const { repo, commit } = makeRepo(standInTool('greet'));
  const project = emptyProject();
  const from = { repo, path: 'tools/greet', commit };
  const output = await add({ project, tool: 'greet', from });
  assert.deepEqual(output.refused, []);
  assert.deepEqual(output.added.map(a => a.tool), ['greet']);
  const line = JSON.parse(readFileSync(join(project, 'trillion', 'where-each-tool-comes-from.json'), 'utf8')).tools.greet;
  assert.deepEqual(line.from, { ...from, repo: originAddress(repo) }, 'the repo is recorded by its origin address, not its folder');
});

test('a from that is not a registry is refused and nothing is written', async () => {
  const project = emptyProject();
  const noRegistry = scratch('no-registry');
  const otherShape = scratch('other-shape');
  writeFileSync(join(otherShape, 'tools-in-this-registry.json'), '{"tools":{"greet":{"repo":"x","path":"tools/greet","commit":"main"}}}\n');
  for (const from of [noRegistry, otherShape, { repo: 'x', path: '../greet', commit: 'a'.repeat(40) }]) {
    const output = await add({ project, tool: 'greet', from });
    assert.deepEqual(output.refused.map(r => r.why), ['bad-from'], JSON.stringify(from));
  }
  assert.equal(existsSync(join(project, 'trillion')), false);
});
