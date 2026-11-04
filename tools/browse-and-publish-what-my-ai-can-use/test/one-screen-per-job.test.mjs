// test/one-screen-per-job.test.mjs
//
// A Workshop tool whose screen is one of the app's own screens (an app-entry naming that screen's entry, under the same
// name) takes that screen's place (`replaces`) instead of being offered beside it, so the screen picker and the sidebar
// never hold two of the same screen ("two Formats, one not loading, one with no screen", 2026-09-30). The tool's row
// then opens the screen straight away, with no Workshop read first, at the screen's own address and its tool address.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { toolSurfaces } from '../../keep-and-wake-ai-sessions-on-this-computer/src/work-workshop.mjs';
import workspaceScreens from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/screens.mjs';

// Every tool the Workshop lists with a screen: the records/workshop-*.json files, less the app's own screen rows.
const tools = readdirSync(new URL('../records/', import.meta.url))
  .filter(name => /^workshop-.*\.json$/.test(name) && name !== 'workshop-screen-tool-records.json')
  .flatMap(name => JSON.parse(readFileSync(new URL(`../records/${name}`, import.meta.url), 'utf8')).records ?? [])
  .map(record => record.payload)
  .filter(tool => tool?.id?.startsWith('tool:') && tool.screen && typeof tool.screen.kind === 'string')
  .map(tool => ({ ...tool, tool_id: tool.id }));

test('no tool offers a second copy of one of the app\'s own screens', () => {
  const shipped = workspaceScreens.surfaces;
  const offered = new Map([...shipped, ...toolSurfaces(tools)].map(row => [row.id, row]));
  for (const tool of tools.filter(one => one.screen.kind === 'app-entry')) {
    const same = shipped.find(row => row.package_entry?.entry_name === tool.screen.entry && row.label === (tool.screen.label ?? tool.label));
    if (!same) continue;
    assert.equal(tool.screen.replaces, same.id, `${tool.id} is ${same.label} itself, so it replaces ${same.id}`);
    assert.equal(offered.has(tool.id), false, `${tool.id} is not offered beside it`);
  }
  const labels = [...offered.values()].filter(row => row.package_entry?.entry_name === 'formats').map(row => row.label);
  assert.deepEqual(labels, ['Formats'], 'one Formats');
});

test('a tool that replaces a screen with that screen itself opens it straight away, at both addresses', () => {
  const [formats] = toolSurfaces(tools.filter(tool => tool.id === 'tool:shape-a-thought-into-formats'));
  assert.equal(formats.id, 'trillion.formats');
  assert.deepEqual(formats.package_entry, { package_name: 'trillion', entry_name: 'formats' });
  assert.equal(formats.material_target, 'component:trillion-formats');
  assert.deepEqual(formats.route_paths, ['/formats', '/use/shape-a-thought-into-formats']);
  assert.equal(formats.label, 'Formats');
  // A replacing tool whose screen is its own (not the screen's entry) still opens through its tool screen.
  const [own] = toolSurfaces([{ tool_id: 'tool:mine', label: 'Mine', screen: { kind: 'described', replaces: 'trillion.formats', label: 'Formats' } }]);
  assert.equal(own.id, 'trillion.formats');
  assert.deepEqual(own.package_entry, { package_name: 'trillion', entry_name: 'tool-screen' });
  assert.deepEqual(own.surface_input, { tool_id: 'tool:mine' });
});
