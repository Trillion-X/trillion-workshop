// B1. What makes a folder ready is DATA in its card: the add tool's own code names no package ecosystem, and a card's
// prepare runs as words in the copied folder (here a plain node command that writes a marker file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { add } from '../do-work/add.ts';
import { emptyProject, makeRegistry, makeRepo, standInTool } from './fixtures.ts';

const tool = resolve(import.meta.dirname, '..');
const sources = ['do-work', 'read-data'].flatMap(folder => readdirSync(join(tool, folder)).map(name => join(tool, folder, name)));

test('the add tool\'s code names no package ecosystem', () => {
  assert.ok(sources.length >= 6);
  for (const file of sources) assert.doesNotMatch(readFileSync(file, 'utf8'), /npm|pip/i, file);
});

test('a card\'s prepare runs in the copied folder', async () => {
  const prepare = ['node', '-e', 'require("node:fs").writeFileSync("ready.txt", process.cwd())'];
  const { repo, commit } = makeRepo(standInTool('greet', { prepare }));
  const project = emptyProject();
  const output = await add({ project, tool: 'greet', from: makeRegistry(repo, commit, { greet: [] }) });
  assert.deepEqual(output.prepared, ['greet']);
  // The prepare's own working folder, as the system names it (on macOS /var is /private/var).
  const folder = realpathSync(join(project, 'greet'));
  assert.equal(readFileSync(join(folder, 'ready.txt'), 'utf8'), folder);
  const skipped = emptyProject();
  const unprepared = await add({ project: skipped, tool: 'greet', from: makeRegistry(repo, commit, { greet: [] }), prepare: false });
  assert.deepEqual(unprepared.prepared, []);
});
