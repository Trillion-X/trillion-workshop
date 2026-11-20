// tools/workspace-screens/test/workspace-pages-alone-addresses.test.mjs
//
// A screen shown alone at its own address outside /workspace (the Mac menu bar panel's /menu-bar) gets a page at that
// address, so the front door answers it; an address under /workspace, a screen not shown alone, and an address that is
// not a plain path are given no page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aloneAddresses } from '../web/scripts/workspace-pages.mjs';

test('the program\'s own alone screens include the menu bar panel', () => {
  assert.ok(aloneAddresses().includes('/menu-bar'));
});

test('only plain addresses outside /workspace of screens shown alone', () => {
  const program = { surfaces: [
    { shown_alone: true, route_paths: ['/menu-bar', '/menu-bar'] },
    { shown_alone: true, route_paths: ['/workspace/alone', '/workspace', '/../etc', '/a b', '/glance/now'] },
    { shown_alone: false, route_paths: ['/elsewhere'] },
    { route_paths: ['/no-flag'] },
  ] };
  assert.deepEqual(aloneAddresses(program), ['/menu-bar', '/glance/now']);
  assert.deepEqual(aloneAddresses({}), []);
});
