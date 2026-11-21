// A screen a tool offers reaches the signed-in page's sidebar by the collection its surface names, whatever its placement
// labels: an offer with no placement_labels and an offer with only "workspace" both appear as sidebar rows. Placement
// labels are read on no path the signed-in page takes: WorkspaceShell's discoverPanelsForPlacement serves only embedded
// workspaces that name a placement_label in their surface input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { surfaceOfScreenTool } from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/screens.mjs';
import { sidebarCollections } from '../web/src/workspace/sidebar-lists.ts';
import surfaces from '../web/src/workspace/surfaces.json' with { type: 'json' };
import looks from '../../keep-and-wake-ai-sessions-on-this-computer/src/workshop-looks.json' with { type: 'json' };

const offer = (id, surface) => ({ id, label: `Screen ${id}`, screen: { kind: 'module', icon: 'Hand', surface: { sidebar_collection: 'everyday', ...surface } } });
const unlabelled = offer('stand-in:no-label', { order: 1 });
const workspaceOnly = offer('stand-in:workspace-label', { order: 2, placement_labels: ['workspace'] });
const offered = [unlabelled, workspaceOnly].map(surfaceOfScreenTool);
const data = { sidebar_collections: surfaces.sidebar_collections, sidebar_content_host_by_section_id: surfaces.sidebar_content_host_by_section_id };

test('an offer with no placement_labels keeps the page placement and is a sidebar row', () => {
  const [row] = offered;
  assert.deepEqual(row.placement_labels, looks.tool_surface_defaults.placement_labels);
  assert.match(JSON.stringify(sidebarCollections(offered, data, 'stand-in-host')), /"id":"stand-in:no-label"/);
});

test('an offer with only the "workspace" placement label is a sidebar row', () => {
  const [, row] = offered;
  assert.deepEqual(row.placement_labels, ['workspace']);
  assert.match(JSON.stringify(sidebarCollections(offered, data, 'stand-in-host')), /"id":"stand-in:workspace-label"/);
});

test('both offers are listed in the collection their surface names, in the offer order', () => {
  const nav = JSON.stringify(sidebarCollections(offered, data, 'stand-in-host'));
  const ids = [...nav.matchAll(/"id":"(stand-in:[^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids, ['stand-in:no-label', 'stand-in:workspace-label']);
});
