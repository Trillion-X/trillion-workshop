// The screens that belong in a pursuit show under that pursuit only, and only while it is the focus.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pursuitNavigationRows } from '../web/src/workspace/pursuit-navigation-rows.mjs';
import { pursuitsFromNames } from '../web/src/workspace/pursuit-list.mjs';

const progress = { id: 'pursuits.screen', opens_kinds: ['pursuit'], route_input: 'pursuit', order: 5, sidebar_collection: 'pursuits', surface_input: {} };
const builder = { id: 'tool:screen-sales-contracts', label: 'Sales contracts', in_pursuit: true, sidebar_collection: 'things-you-do-as-input' };
const pursuits = pursuitsFromNames(['alpha_for_who_runs_it-connection', 'beta_for_who_runs_it-connection']);

test('a pursuit row is one per vault pursuit, titled from its name', () => {
  const rows = pursuitNavigationRows(pursuits, [progress], () => null);
  assert.deepEqual(rows.map(row => row.label), ['Alpha', 'Beta']);
  assert.deepEqual(rows.map(row => row.id), ['pursuit:alpha', 'pursuit:beta']);
});

test('only the focused pursuit gets its in-pursuit screens, nested under it', () => {
  const rows = pursuitNavigationRows(pursuits, [progress], pursuit => (pursuit.id === 'alpha' ? [builder] : null));
  const parts = rows.filter(row => row.source.part_of_pursuit);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].id, 'pursuit:alpha:part:tool:screen-sales-contracts');
  assert.equal(parts[0].source.pursuit_parent_id, 'pursuit:alpha');
  assert.equal(parts[0].label, 'Sales contracts');
});

test('no focus, no parts: every pursuit row stands alone', () => {
  const rows = pursuitNavigationRows(pursuits, [progress], () => null);
  assert.equal(rows.some(row => row.source.part_of_pursuit), false);
});
