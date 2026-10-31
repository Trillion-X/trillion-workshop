// tools/funnels-and-offers/test/stage-measures.test.mjs
// Per-stage counts from facts: any group-by field and any amount field, so a hiring pipeline counts the same way as an offer ladder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceStageMeasures } from '../read-data/stage-measures.mjs';

test('counts visits, conversions (converted flag or an amount) and revenue per stage', () => {
  const facts = [
    { stage_ref: 'a', amount_cents: 900 }, { stage_ref: 'a' }, { stage_ref: 'a', converted: true },
    { stage_ref: 'b', amount_cents: 400 }, { stage_ref: 'zzz' }, { stage_ref: 7 }, null, 'x',
  ];
  const measures = reduceStageMeasures(facts, ['a', 'b'], 'stage_ref', 'amount_cents');
  assert.deepEqual(measures.a, { visits: 3, conversions: 2, conversion_rate: 66.7, revenue_cents: 900 });
  assert.deepEqual(measures.b, { visits: 1, conversions: 1, conversion_rate: 100, revenue_cents: 400 });
});

test('the same reducer counts a hiring pipeline: other field names, ids contained in a longer reference', () => {
  const facts = [{ who: 'stage:hire:applied', salary_cents: 5000000 }, { who: 'stage:hire:applied' }, { who: 'stage:hire:screened', converted: true }];
  const measures = reduceStageMeasures(facts, ['applied', 'screened', 'offer'], 'who', 'salary_cents');
  assert.equal(measures.applied.visits, 2);
  assert.equal(measures.applied.revenue_cents, 5000000);
  assert.equal(measures.screened.conversions, 1);
  assert.deepEqual(measures.offer, { visits: 0, conversions: 0, conversion_rate: 0, revenue_cents: 0 });
});

test('empty or non-list facts give zero measures', () => {
  assert.deepEqual(reduceStageMeasures([], ['a'], 'x', 'y'), { a: { visits: 0, conversions: 0, conversion_rate: 0, revenue_cents: 0 } });
  assert.equal(reduceStageMeasures(undefined, ['a'], 'x', 'y').a.visits, 0);
});
