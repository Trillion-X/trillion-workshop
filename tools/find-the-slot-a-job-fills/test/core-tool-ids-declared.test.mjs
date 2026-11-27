// tools/find-the-slot-a-job-fills/test/core-tool-ids-declared.test.mjs
// Every tool the engine stands on (CORE_TOOL_IDS) must be declared by a tool row in the Workshop. Before this fix,
// tool:evaluate-binding was named there and no row declared it (its row is tool:evaluate-a-formula).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_TOOL_IDS } from '../src/job-slots.mjs';

const toolsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function toolRowFiles(dir, found = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'from-an-older-version' || name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) toolRowFiles(path, found);
    else if (name === 'what-this-tool-does-and-how-to-run-it.json') found.push(path);
  }
  return found;
}

const rowText = toolRowFiles(toolsRoot).map(path => readFileSync(path, 'utf8')).join('\n');

test('evaluate-a-formula replaces the undeclared evaluate-binding in CORE_TOOL_IDS', () => {
  assert.ok(CORE_TOOL_IDS.includes('tool:evaluate-a-formula'));
  assert.ok(!CORE_TOOL_IDS.includes('tool:evaluate-binding'));
});

for (const id of CORE_TOOL_IDS) {
  test(`${id} is declared by a tool row`, () => {
    assert.ok(rowText.includes(`"id": "${id}"`), `no tool row declares ${id}`);
  });
}
