// A tool in the account's catalogue that no Workshop part.json names is offered as its own screen: its list row carries
// no screen, its kept description declares one, and the sidebar holds it by the folder that screen names. Nothing here
// names the tool; the stand-in's list row and its description are data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueRows } from '../web/src/workspace/tool-catalogue-rows.mjs';
import { sidebarCollections } from '../web/src/workspace/sidebar-lists.ts';

const ELSEWHERE = 'elsewhere/tool:hello-from-elsewhere';
const listRow = { id: ELSEWHERE, label: 'Hello from elsewhere', job: 'Say hello from another computer.' };
const described = {
  id: ELSEWHERE, label: 'Hello from elsewhere', runs_here: true,
  screen: { kind: 'parts', label: 'Hello', icon: 'Hand', group: 'elsewhere-folder', spec: { root: 'page', elements: {} }, requests: {} },
};

test('a catalogue row with no screen of its own is a plain tool screen', () => {
  const [row] = catalogueRows([listRow]);
  assert.equal(row.id, ELSEWHERE);
  assert.equal(row.label, 'Hello from elsewhere');
  assert.equal(row.source.group, undefined);
});

test('the screen a tool declared on this computer labels its row, icon and folder from the first draw', () => {
  const [row] = catalogueRows([listRow], new Map([[ELSEWHERE, described.screen]]));
  assert.equal(row.label, 'Hello');
  assert.equal(row.icon, 'Hand');
  assert.equal(row.source.group, 'elsewhere-folder');
  assert.equal(row.surface_input.tool_id, ELSEWHERE);
});

test('a screen the list answer itself carries wins over the kept one', () => {
  const own = { ...described.screen, label: 'From the list' };
  const [row] = catalogueRows([{ ...listRow, screen: own }], new Map([[ELSEWHERE, described.screen]]));
  assert.equal(row.label, 'From the list');
});

test('the sidebar holds the tool in the folder its screen names, and in no other folder', () => {
  const rows = catalogueRows([listRow], new Map([[ELSEWHERE, described.screen]]));
  const data = {
    sidebar_content_host_by_section_id: {},
    sidebar_collections: [
      { id: 'folder', name: 'Folder', holds: { path: ['source', 'group'], equals: 'elsewhere-folder' } },
      { id: 'other', name: 'Other', holds: { path: ['source', 'group'], equals: 'something-else' } },
    ],
  };
  const nav = JSON.stringify(sidebarCollections(rows, data, 'stand-in-host'));
  assert.match(nav, /"id":"stand-in-host-folder"/);
  assert.match(nav, new RegExp(`"id":"${ELSEWHERE}"`));
  assert.doesNotMatch(nav, /"id":"stand-in-host-other"/);
});
