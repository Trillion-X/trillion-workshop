// No tool has a screen drawn from its input schema. A tool's own screen is one of the kinds the page can show
// (src/workshop.mjs SCREEN_KINDS); a tool with none is done on the screen that already hosts its job (the file card,
// the editor, Automations, the tray) or by the person's AI, and gets no tab (src/work-workshop.mjs toolSurfaces).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { toolSurfaces } from '../src/work-workshop.mjs';

const toolsDir = new URL('../../', import.meta.url).pathname;
const jsonFiles = folder => readdirSync(folder).flatMap(name => {
  if (name === 'node_modules' || name === '.git') return [];
  const path = join(folder, name);
  return statSync(path).isDirectory() ? jsonFiles(path) : name.endsWith('.json') ? [path] : [];
});

test('no tool row in the Workshop declares the generic screen kind', () => {
  const found = [];
  const walk = (value, file) => {
    if (Array.isArray(value)) return value.forEach(item => walk(item, file));
    if (!value || typeof value !== 'object') return;
    if (value.screen && typeof value.screen === 'object' && value.screen.kind === 'described') found.push(`${file} ${value.id ?? ''}`);
    Object.values(value).forEach(item => walk(item, file));
  };
  for (const file of jsonFiles(toolsDir)) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    walk(parsed, file.slice(toolsDir.length));
  }
  assert.deepEqual(found, []);
});

test('a tool with no screen kind has no tab, however it is offered on a file', () => {
  const rows = toolSurfaces([
    { tool_id: 'tool:with-a-run', next_call: { tool: 'run_tool' } },
    { tool_id: 'tool:offered-on-a-file', next_call: { tool: 'run_tool' }, screen: { inputs: { file: { file: { takes: 'video' } } } } },
    { tool_id: 'tool:with-its-own', screen: { kind: 'app-entry', entry: 'files' } },
  ]);
  assert.deepEqual(rows.map(row => row.id), ['tool:with-its-own']);
});

test('the validator names the screen kinds a tool may declare, and the generic one is not among them', () => {
  const source = readFileSync(new URL('../src/workshop.mjs', import.meta.url), 'utf8');
  const kinds = source.match(/const SCREEN_KINDS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
  assert.ok(kinds.includes("'app-entry'"));
  assert.ok(!kinds.includes('described'));
});
