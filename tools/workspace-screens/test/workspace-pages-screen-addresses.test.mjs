// tools/workspace-screens/test/workspace-pages-screen-addresses.test.mjs
//
// Every screen at its own address outside /workspace gets a page at that address, so the front door answers it: the program's
// own surfaces (the Mac menu bar panel's /menu-bar) and each tool's screen offers (the owner's grants screen at /grants). An
// address under /workspace and an address that is not a plain path are given no page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { screenAddresses, toolScreenSurfaces } from '../web/scripts/workspace-pages.mjs';

test('the real addresses include the menu bar panel and the grants screen', () => {
  const addresses = screenAddresses();
  assert.ok(addresses.includes('/menu-bar'));
  assert.ok(addresses.includes('/grants'));
});

test('only plain addresses outside /workspace, from the program and from tool offers, each once', () => {
  const program = { surfaces: [
    { shown_alone: true, route_paths: ['/menu-bar', '/menu-bar'] },
    { route_paths: ['/workspace/alone', '/workspace', '/../etc', '/a b', '/glance/now'] },
    { route_paths: ['/calendar'] },
  ] };
  assert.deepEqual(screenAddresses(program, [{ route_paths: ['/grants', '/calendar'] }, { route_paths: [7] }]), ['/menu-bar', '/glance/now', '/calendar', '/grants']);
  assert.deepEqual(screenAddresses({}, []), []);
});

test('a tool folder\'s screen surfaces come from its part.json offers; a folder with no part.json or no screen adds none', () => {
  const tools = mkdtempSync(join(tmpdir(), 'screen-addresses-'));
  for (const [name, part] of [['a', { offers: [{ screen: { surface: { route_paths: ['/a'] } } }, { id: 'no-screen' }] }], ['b', null], ['c', 'not json']]) {
    mkdirSync(join(tools, name));
    if (part !== null) writeFileSync(join(tools, name, 'part.json'), typeof part === 'string' ? part : JSON.stringify(part));
  }
  assert.deepEqual(toolScreenSurfaces(tools), [{ route_paths: ['/a'] }]);
});
