// The record write is a compare-and-set under one lock: while another live add holds the lock, this add is refused as
// record-changed-meanwhile and places no folder; a lock left by a process that is gone is taken over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../do-work/add.ts';
import { emptyProject, makeRegistry, makeRepo, standInTool } from './fixtures.ts';

test('a held record lock refuses the add; a dead holder\'s lock is taken over', async () => {
  const { repo, commit } = makeRepo(standInTool('greet'));
  const registry = makeRegistry(repo, commit, { greet: [] });
  const project = emptyProject();
  const lock = join(project, '.where-each-tool-comes-from.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const held = await add({ project, tool: 'greet', from: registry });
  assert.deepEqual(held.refused.map(r => r.why), ['record-changed-meanwhile']);
  assert.equal(existsSync(join(project, 'greet')), false);
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345 }));
  const taken = await add({ project, tool: 'greet', from: registry });
  assert.deepEqual(taken.refused, []);
  assert.deepEqual(taken.added.map(a => a.tool), ['greet']);
  assert.equal(existsSync(lock), false);
});
