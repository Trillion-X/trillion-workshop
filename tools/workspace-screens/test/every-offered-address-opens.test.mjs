// Every screen a tool offers in its part.json `offers` is reached by each of its addresses (route_paths): the shell's
// own address reader (web/src/workspace/addresses.mjs screenAt) gives that same screen back, and no two offered screens
// claim the same address. One generic check for every tool, so no tool needs its own address test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { offeredRows } from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/offered-screens.mjs';
import { surfaceOfScreenTool } from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/screens.mjs';
import screens from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/screens.mjs';
import { screenAt } from '../web/src/workspace/addresses.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const offered = offeredRows(root).filter(row => row.screen?.surface && typeof row.screen.surface === 'object');
const surfaces = offered.map(row => surfaceOfScreenTool(row));
const everything = [...screens.surfaces, ...surfaces];

test('the build reads offered screens to check', () => {
  assert.ok(offered.length > 0, 'no offered screen rows were read');
});

test('each address of an offered screen opens that same screen', () => {
  const failures = [];
  for (const surface of surfaces) {
    for (const address of surface.route_paths ?? []) {
      const opened = screenAt(everything, address)?.row?.id;
      if (opened !== surface.id) failures.push(`${address} opens ${opened ?? 'nothing'}, not ${surface.id}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('no two offered screens claim the same address', () => {
  const claimed = new Map();
  const clashes = [];
  for (const surface of surfaces) {
    for (const address of surface.route_paths ?? []) {
      if (claimed.has(address)) clashes.push(`${address} claimed by ${claimed.get(address)} and ${surface.id}`);
      else claimed.set(address, surface.id);
    }
  }
  assert.deepEqual(clashes, []);
});
