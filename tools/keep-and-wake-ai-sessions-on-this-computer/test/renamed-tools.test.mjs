import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import renamed from '../src/renamed-tools.json' with { type: 'json' };
import { agentForTool } from '../../hand-off-jobs-between-agents/src/agent-tool-runs.mjs';
import { cardSkillFor, currentToolId, formerAgentIds } from '../../shared-code/src/renamed-tools.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPUTER = fileURLToPath(new URL('../../run-on-a-persons-computer/', import.meta.url));
const formerNames = [...Object.keys(renamed.tools), ...Object.keys(renamed.agents), ...Object.keys(renamed.agent_prefixes), ...Object.keys(renamed.configurations)];

function filesUnder(dir, keep) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path, keep);
    return keep(path) ? [path] : [];
  });
}

test('no former tool, agent, prefix or configuration id remains in records, src or the computer JSON', () => {
  const table = join(ROOT, 'src', 'renamed-tools.json');
  const scanned = [
    ...filesUnder(join(ROOT, 'records'), path => /\.(json|mjs)$/.test(path)),
    ...filesUnder(join(ROOT, 'src'), path => /\.(json|mjs)$/.test(path) && path !== table),
    // Old trillion's computer/*.json moved into tools/run-on-a-persons-computer (a9ee2580).
    ...readdirSync(COMPUTER).filter(name => name.endsWith('.json')).map(name => join(COMPUTER, name)),
  ];
  const hits = [];
  for (const path of scanned) {
    const text = readFileSync(path, 'utf8');
    for (const former of formerNames) if (text.includes(former)) hits.push(`${relative(ROOT, path)}: ${former}`);
  }
  assert.deepEqual(hits, []);
});

test('every current tool id is the payload id of a workshop tool record', () => {
  const ids = new Set();
  for (const name of readdirSync(join(ROOT, 'records'))) {
    if (!/^workshop-.*-tool-records\.json$/.test(name)) continue;
    const file = JSON.parse(readFileSync(join(ROOT, 'records', name), 'utf8'));
    for (const row of file.records ?? []) if (row?.payload?.id) ids.add(row.payload.id);
  }
  // A tool whose rows moved to a Workshop tool folder is read from the installed package (records/tool-folders.json).
  const tools = fileURLToPath(new URL('./tools/', import.meta.resolve('trillion-workshop/package.json')));
  for (const folder of readdirSync(tools)) {
    let file;
    try { file = JSON.parse(readFileSync(join(tools, folder, 'tool-rows.json'), 'utf8')); } catch { continue; }
    for (const row of file.records ?? []) if (row?.payload?.id) ids.add(row.payload.id);
  }
  for (const current of new Set(Object.values(renamed.tools))) {
    assert.ok(ids.has(current), `${current} is not a payload.id in records/workshop-*-tool-records.json or a Workshop tool folder's tool-rows.json`);
  }
});

test('cardSkillFor prefers the current id, falls back to a former id, and is null for neither', () => {
  const current = { skills: [{ id: 'tool:ask-a-model' }] };
  const former = { skills: [{ id: 'tool:ask-a-model-on-this-mac' }] };
  const neither = { skills: [{ id: 'tool:something-else' }] };
  assert.equal(cardSkillFor(current, 'tool:ask-a-model-on-this-mac').id, 'tool:ask-a-model');
  assert.equal(cardSkillFor(former, 'tool:ask-a-model').id, 'tool:ask-a-model-on-this-mac');
  assert.equal(cardSkillFor(neither, 'tool:ask-a-model'), null);
  assert.equal(cardSkillFor(null, 'tool:ask-a-model'), null);
  assert.equal(currentToolId('tool:ask-a-model-on-this-mac'), 'tool:ask-a-model');
  assert.deepEqual(formerAgentIds('computer-tools:abc'), ['this-mac-tools:abc']);
});

test('agentForTool finds a computer that advertises only the former agent id and former tool skill', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const card = {
    agent_id: 'this-mac-tools:abc123',
    takes_work: true,
    skills: [{ id: 'tool:ask-a-model-on-this-mac' }, { id: 'computer-sources:abc123' }],
    capacity_claim: { max_concurrent: 1, expires_at: '2026-10-10T12:00:00Z' },
  };
  const agents = {
    cardOf: id => (id === 'this-mac-tools:abc123' ? card : undefined),
    reach: () => ({ present: true, live: true }),
  };
  const settings = {
    agent_id: 'trillion-workshop',
    computer_scope: { tool_ids: ['tool:ask-a-model'], input_field: 'computer_id', agent_prefix: 'computer-tools:', skill_prefix: 'computer-sources:' },
  };
  assert.equal(agentForTool({ agents, settings, tool_id: 'tool:ask-a-model', input: { computer_id: 'abc123' }, now }), 'this-mac-tools:abc123');
});
