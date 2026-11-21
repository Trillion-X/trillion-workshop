// A screen a tool offers with `in_pursuit: true` in its part.json is listed under the pursuit the focus names, and only then.
// It reads the real build path: every tool's part.json offers (offeredScreens, keep-and-wake-ai-sessions-on-this-computer), the
// workspace's own surfaces (surfaces.json), and the pursuit rows built from the vault's pursuit connections.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offeredScreens } from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/offered-screens.mjs';
import { pursuitNavigationRows } from '../web/src/workspace/pursuit-navigation-rows.mjs';
import { pursuitsFromNames } from '../web/src/workspace/pursuit-list.mjs';
import { partsOf } from '../web/src/workspace/pursuit-parts.ts';

const built = offeredScreens().surfaces;
const inPursuit = built.filter(row => row.in_pursuit === true);
const pursuits = pursuitsFromNames(['alpha_for_who_runs_it-connection', 'beta_for_who_runs_it-connection']);
const focusOn = id => ({ pursuits: [id] });
const rowsFor = focus => pursuitNavigationRows(pursuits, built, pursuit => partsOf(pursuit, inPursuit, focus));

test('the build offers the sales screen as in-pursuit, from its tool part.json', () => {
  assert.deepEqual(inPursuit.map(row => row.id), ['sales-contracts.screen']);
});

test('with the first pursuit focused, the sales screen nests under that pursuit and nowhere else', () => {
  const rows = rowsFor(focusOn('alpha'));
  const under = rows.filter(row => row.source.part_of_pursuit).map(row => [row.source.pursuit_parent_id, row.surface_id]);
  assert.deepEqual(under, [['pursuit:alpha', 'pursuit:alpha:part:sales-contracts.screen']]);
  const row = rows.findIndex(item => item.id === 'pursuit:alpha');
  assert.equal(rows[row + 1].source.part_of_pursuit, true);
  assert.equal(rows[row + 1].label, 'Sales contracts');
});

test('the screen shows under whichever pursuit is focused, and the pursuit rows stay', () => {
  const rows = rowsFor(focusOn('beta'));
  assert.deepEqual(rows.filter(row => row.source.part_of_pursuit).map(row => row.source.pursuit_parent_id), ['pursuit:beta']);
  assert.ok(rows.some(row => row.id === 'pursuit:alpha'));
});

test('with no focus, no screen shows under any pursuit', () => {
  const rows = rowsFor({ pursuits: [] });
  assert.equal(rows.some(row => row.source.part_of_pursuit), false);
});
