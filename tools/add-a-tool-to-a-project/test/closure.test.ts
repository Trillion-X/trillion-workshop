// 7. Adding a tool also adds the sibling folders it needs, each as its own record line, so its `../../<folder>/` imports
// resolve under the project's trillion/: hash-content-with-blake3 brings content-identity, and the copied entry hashes
// "abc" to the published BLAKE3 vector. The stand-in repo holds the two folders exactly as this Workshop commits them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { add } from '../do-work/add.ts';
import { tarFiles } from '../../content-identity/read-data/manifest.mjs';
import { emptyProject, makeRegistry, makeRepo, originAddress } from './fixtures.ts';

const workshop = resolve(import.meta.dirname, '../../..');
const committed = (paths: string[]): Record<string, string> => Object.fromEntries(
  tarFiles(execFileSync('git', ['-C', workshop, 'archive', '--format=tar', 'HEAD', '--', ...paths], { maxBuffer: 1 << 30 }))
    .map(([name, bytes]: [string, Buffer]) => [name, bytes.toString('utf8')]));

test('a tool\'s needs come with it and its sibling imports resolve', async () => {
  // Made-up copies of the two committed folders under the test's own temp folder, each with its card.
  const files = committed(['tools/hash-content-with-blake3', 'tools/content-identity']);
  const { repo, commit } = makeRepo(files);
  const registry = makeRegistry(repo, commit, { 'hash-content-with-blake3': ['content-identity'], 'content-identity': [] });
  const project = emptyProject();
  const output = await add({ project, tool: 'hash-content-with-blake3', from: registry });
  assert.deepEqual(output.refused, []);
  assert.deepEqual(output.added.map(a => a.tool).sort(), ['content-identity', 'hash-content-with-blake3']);
  const record = JSON.parse(readFileSync(join(project, 'trillion', 'where-each-tool-comes-from.json'), 'utf8'));
  assert.deepEqual(record.tools['hash-content-with-blake3'].needs_tools, ['content-identity']);
  assert.deepEqual(record.tools['content-identity'].from, { registry: originAddress(registry), tool: 'content-identity' });
  assert.notEqual(record.tools['hash-content-with-blake3'].closure_blake3, record.tools['content-identity'].closure_blake3);
  // The project's own packages: this checkout's, as a project's workspace install would give them.
  symlinkSync(join(workshop, 'node_modules'), join(project, 'node_modules'));
  const answer = JSON.parse(execFileSync('node', [join(project, 'trillion', 'hash-content-with-blake3', 'do-work', 'hash-content.mjs'), project],
    { input: '{"text":"abc"}', encoding: 'utf8' }));
  assert.equal(answer.result.blake3, '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
});
