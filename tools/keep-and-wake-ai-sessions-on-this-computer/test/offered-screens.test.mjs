// A tool that offers a screen in its own part.json appears in the workspace's screens with no other change, and a tool that
// offers a screen drawn from its inputs is refused. Synthetic Workshop folders only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { offeredRows, offeredScreens } from '../src/workspace/offered-screens.mjs';

const row = (id, kind = 'module') => ({ id, label: 'Synthetic', screen: { kind, icon: 'Box', module: { package: 'synthetic', entry: 'show.tsx' }, surface: { id, surface_id: id, kind: 'placeable-surface', sidebar_collection: 'synthetic-group', order: 5, route_paths: ['/synthetic'] } } });
const workshop = (t, tools) => {
  const root = mkdtempSync(join(tmpdir(), 'offered-screens-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, part] of Object.entries(tools)) { mkdirSync(join(root, 'tools', name), { recursive: true }); writeFileSync(join(root, 'tools', name, 'part.json'), JSON.stringify(part)); }
  return root;
};

test('a tool offering a screen in part.json appears in the screens with its own group, order and label', t => {
  const root = workshop(t, { 'synthetic-tool': { offers: [row('tool:synthetic-one')] }, 'quiet-tool': { exports: {} } });
  const found = offeredScreens(root).surfaces.find(surface => surface.id === 'tool:synthetic-one');
  assert.equal(found.label, 'Synthetic');
  assert.equal(found.sidebar_collection, 'synthetic-group');
  assert.equal(found.order, 5);
  assert.deepEqual(found.surface_input, { tool_id: 'tool:synthetic-one' });
});

test('a screen drawn from a tool\'s description or inputs is refused', t => {
  assert.throws(() => offeredRows(workshop(t, { 'synthetic-tool': { offers: [row('tool:synthetic-two', 'described')] } })), /never one drawn from its description or inputs/);
});

test('an id offered twice, or already a screen row, is refused', t => {
  assert.throws(() => offeredScreens(workshop(t, { a: { offers: [row('tool:synthetic-three')] }, b: { offers: [row('tool:synthetic-three')] } })), /already a screen row/);
});
