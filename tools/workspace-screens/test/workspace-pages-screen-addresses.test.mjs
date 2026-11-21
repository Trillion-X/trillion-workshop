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
import { readFileSync } from 'node:fs';
import { prefixPage, screenAddresses, screenPrefixes, toolScreenSurfaces } from '../web/scripts/workspace-pages.mjs';

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

test('each route_prefix of one or two plain segments, from the program and from tool offers, each once; a deeper or odd one is not listed', () => {
  const program = { surfaces: [
    { route_prefix: '/file/' },
    { route_prefix: '/record/about/' },
    { route_prefix: '/file/' },
    { route_prefix: '/a/b/c/' },
    { route_prefix: '/Bad/' },
    { route_prefix: '/file' },
    { route_prefix: 7 },
  ] };
  assert.deepEqual(screenPrefixes(program, [{ route_prefix: '/use/' }, {}]), ['/file/', '/record/about/', '/use/']);
  assert.deepEqual(screenPrefixes({}, []), []);
});

test('a prefix page is named for its segments: /file/ is file.prefix.html, /record/about/ is record.about.prefix.html', () => {
  assert.equal(prefixPage('/file/'), 'file.prefix.html');
  assert.equal(prefixPage('/record/about/'), 'record.about.prefix.html');
});

test('every route_prefix the real screens name is one or two segments, so the front door has a rule for each', () => {
  const program = JSON.parse(readFileSync(new URL('../web/src/workspace/native-screen-program.json', import.meta.url), 'utf8'));
  const named = [...(program.surfaces ?? []), ...toolScreenSurfaces()].map(surface => surface.route_prefix).filter(Boolean);
  assert.ok(named.includes('/file/') && named.includes('/record/about/'), 'the real list includes the file screen and a two-segment prefix');
  assert.deepEqual(named.filter(prefix => !screenPrefixes().includes(prefix)), [], 'a prefix the front door cannot answer is a finding, not a silent gap');
});
