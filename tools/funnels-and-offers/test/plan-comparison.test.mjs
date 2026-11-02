// tools/funnels-and-offers/test/plan-comparison.test.mjs
// The plan comparison moved from the Trillion engine: every row is well formed and no unreleased plan name is in this public folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const comparison = JSON.parse(readFileSync(new URL('../read-data/plan-comparison.json', import.meta.url), 'utf8'));

test('every plan rung names an offer sold today; a name-only rung is never published here', () => {
  assert.ok(comparison.plan_names.rungs.length > 0);
  for (const rung of comparison.plan_names.rungs) {
    assert.match(rung.offer, /^offer:[a-z0-9-]+$/);
    assert.equal(rung.name, undefined);
  }
});

test('every feature row has one id and a way to judge an offer by it', () => {
  const ids = new Set();
  for (const row of comparison.features) {
    assert.match(row.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(row.id), `duplicate feature ${row.id}`);
    ids.add(row.id);
    assert.ok(typeof row.label === 'string' && row.label.length > 0, `${row.id} has a label`);
    assert.ok(
      ['access', 'allowance_of', 'usage_of', 'every_account', 'spending_terms'].some((rule) => rule in row),
      `${row.id} names how an offer is judged`,
    );
    if (row.allowance_of) assert.ok(row.unit && row.per, `${row.id} names its unit and period`);
    for (const path of row.paths ?? []) {
      assert.ok(typeof (path.exact ?? path.under) === 'string', `${row.id} path is exact or under`);
    }
    if (row.paths) assert.ok(row.needs_plan, `${row.id} says what a paid plan unlocks`);
  }
  assert.ok(comparison.words.needs_plan && comparison.words.needs_plan_action);
  assert.ok(comparison.compares.offers_granting);
});
