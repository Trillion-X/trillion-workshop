// Price testing is the operator's own business: a customer is never shown that prices are being tested. The Price
// tests screen is offered only to a viewer holding audience:operator, and every tour that shows it or announces price
// tests starts only for that viewer.
//
// Ported from the old repository's test/price-tests-operator-only.test.mjs (commit b6ae0ebf81, 48 lines, 4 tests), which the
// move left behind. All four assertions are kept. The screen row is now tool:screen-price-tests in tools/read-a-list-view/part.json;
// the tours and the offer filter are in tools/workspace-screens/web/src/workspace/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import listViews from '../../read-a-list-view/part.json' with { type: 'json' };

const screens = new URL('../../workspace-screens/web/src/workspace/', import.meta.url);
const walkthroughs = new URL('walkthroughs/', screens);
const tours = readdirSync(walkthroughs).filter(name => name.endsWith('.json') && name !== 'pictures.json')
  .map(name => JSON.parse(readFileSync(new URL(name, walkthroughs), 'utf8')))
  .filter(tour => tour?.kind === 'walkthrough-definition');

// The screen's surface is found by the screen it opens (price-tests), and its id is read from the row, never written here.
const find = node => {
  if (Array.isArray(node)) { for (const item of node) { const found = find(item); if (found) return found; } return null; }
  if (node && typeof node === 'object') {
    if (node.surface_input?.screen === 'price-tests') return node;
    for (const value of Object.values(node)) { const found = find(value); if (found) return found; }
  }
  return null;
};
const priceTestsRow = find(listViews);
const surfaceId = priceTestsRow?.surface_id;

test('the Price tests screen is offered only to the operator', () => {
  assert.ok(priceTestsRow, 'the Price tests screen row exists');
  assert.ok(surfaceId, 'the row names its surface');
  assert.equal(priceTestsRow.audience, 'operator');
});

test('the Price tests tour and the price experiments announcement start only for the operator', () => {
  for (const id of ['price-tests', 'whats-new-2026-10-03-price-experiments']) {
    const tour = tours.find(row => row.id === id);
    assert.ok(tour, `${id} exists`);
    assert.equal(tour.audience, 'operator', `${id} names the operator audience`);
  }
});

test('every tour that opens the Price tests screen is for the operator', () => {
  const opens = tours.filter(tour => JSON.stringify(tour).includes(surfaceId) || JSON.stringify(tour).includes('"screen":"price-tests"')
    || JSON.stringify(tour).includes('"entry":"price-tests"'));
  assert.ok(opens.length > 0);
  for (const tour of opens) assert.equal(tour.audience, 'operator', `${tour.id} opens Price tests`);
});

// The screen now reaches the page as its tool row's surface (tool:screen-price-tests), not from the page's own catalogue.
test('the page leaves the Price tests screen out for a customer and offers it to the operator', async () => {
  const { outputFiles: [bundled] } = await build({
    stdin: { contents: "export { offeredScreens } from './offered-screens';", resolveDir: screens.pathname, loader: 'ts' },
    alias: { 'trillion-workshop': new URL('../../../', import.meta.url).pathname.replace(/\/$/, '') },
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    loader: { '.json': 'json' }, define: { 'process.env.NODE_ENV': '"production"' },
  });
  const { offeredScreens } = await import(`data:text/javascript;base64,${Buffer.from(bundled.text).toString('base64')}`);
  const ids = viewer => offeredScreens(viewer, [priceTestsRow]).map(row => row.surface_id ?? row.id);
  assert.ok(!ids({ access_refs: [] }).includes(surfaceId), 'a customer is not offered Price tests');
  assert.ok(ids({ access_refs: ['audience:operator'] }).includes(surfaceId), 'the operator is offered Price tests');
});
