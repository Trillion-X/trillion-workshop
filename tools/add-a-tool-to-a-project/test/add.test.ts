// 1. An empty project and a stand-in registry: the tool folder is written with exactly the pointer's files, and its record
// line says where it came from, synced, the pointer's identity and a files map that matches the disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../do-work/add.ts';
import { fileDigest } from '../../content-identity/read-data/manifest.mjs';
import { emptyProject, makeRegistry, makeRepo, originAddress, pinOf, standInTool } from './fixtures.ts';

test('add writes the pointer\'s files and one record line for them', async () => {
  const { repo, commit } = makeRepo(standInTool('greet'));
  const registry = makeRegistry(repo, commit, { greet: [] });
  const project = emptyProject();
  const output = await add({ project, tool: 'greet', from: registry });
  const pin = pinOf(repo, commit, 'tools/greet');
  assert.deepEqual(output.refused, []);
  assert.deepEqual(output.added.map(a => [a.tool, a.commit, a.files, a.files_blake3]), [['greet', commit, 2, pin]]);
  const record = JSON.parse(readFileSync(join(project, 'trillion', 'where-each-tool-comes-from.json'), 'utf8'));
  const line = record.tools.greet;
  assert.deepEqual(line.from, { registry: originAddress(registry), tool: 'greet' });
  assert.equal(line.synced, true);
  assert.equal(line.copied_at_commit, commit);
  assert.equal(line.copied_at_files_blake3, pin);
  assert.match(line.closure_blake3, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(line.files).sort(), ['do-work/x.mjs', 'what-this-tool-does-and-how-to-run-it.json']);
  for (const [path, digest] of Object.entries(line.files)) assert.equal(fileDigest(readFileSync(join(project, 'trillion', 'greet', path))), digest);
  assert.equal(record.registry, originAddress(registry));
});
