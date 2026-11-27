import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kitProblems } from '../../workflows/read-data/kit-problems.mjs';

const read = relative => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
const id = 'tool:manage-claude-cloud-sessions';

test('Claude Cloud operations are published exactly once with a bounded input schema', () => {
  const rows = read('../what-this-tool-does-and-how-to-run-it.json').records.map(row => row.payload);
  const found = rows.filter(row => row.id === id);
  assert.equal(found.length, 1);
  const tool = found[0];
  assert.deepEqual(tool.placements, ['placement:your-computer']);
  assert.deepEqual(tool.input_schema.properties.action.enum, ['accounts', 'list', 'read', 'resume', 'start']);
  assert.equal(tool.input_schema.additionalProperties, false);
  assert.deepEqual(tool.invoke, { kind: 'computer-tool', tool_id: id });
  assert.deepEqual(kitProblems(read('../kits/manage-claude-cloud-sessions.json'), { tool }), []);
});

test('the owned computer host maps this exact operation to its module and function', () => {
  const host = read('../../run-on-a-persons-computer/mac-tools.json');
  assert.deepEqual(host.tools[id], {
    workshop: 'tools/keep-and-wake-ai-sessions-on-this-computer/harness/claude-cloud-control.mjs',
    function: 'manageClaudeCloudSessions',
  });
});
