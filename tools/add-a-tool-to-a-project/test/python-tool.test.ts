// 4. A Python tool whose card says how to make it ready: the card's prepare (here: make a virtual environment) is run in
// the folder, the tool is `prepared`, and what prepare made is never in the record's files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../do-work/add.ts';
import { emptyProject, makeRegistry, makeRepo } from './fixtures.ts';

test('prepare from the card makes the folder ready and stays out of the record', async () => {
  const { repo, commit } = makeRepo({
    'tools/say/what-this-tool-does-and-how-to-run-it.json': `${JSON.stringify({ records: [], prepare: ['python3', '-m', 'venv', '.venv'] })}\n`,
    'tools/say/requirements.txt': '\n',
    'tools/say/say.py': 'print("hello")\n',
  });
  const registry = makeRegistry(repo, commit, { say: [] });
  const project = emptyProject();
  const output = await add({ project, tool: 'say', from: registry });
  assert.deepEqual(output.refused, []);
  assert.deepEqual(output.prepared, ['say']);
  assert.deepEqual(output.not_prepared, []);
  assert.ok(existsSync(join(project, 'trillion', 'say', '.venv', 'bin', 'python3')), 'the virtual environment was made');
  const line = JSON.parse(readFileSync(join(project, 'trillion', 'where-each-tool-comes-from.json'), 'utf8')).tools.say;
  assert.deepEqual(Object.keys(line.files).sort(), ['requirements.txt', 'say.py', 'what-this-tool-does-and-how-to-run-it.json']);
  const again = await add({ project, tool: 'say', clones: [registry] });
  assert.deepEqual(again.already, ['say'], 'what prepare made is not an edit');
});
