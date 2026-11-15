// tools/funnels-and-offers/test/stage-measures.test.mjs
// Per-stage counts from facts: any group-by field and any amount field, so a hiring pipeline counts the same way as an offer ladder.
import test from 'node:test';
import { readFileSync } from 'node:fs';
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

test('reference prefixes cannot move visits or revenue into another stage', () => {
  const stages = reduceStageMeasures([{ stage: 'node:program', amount: 900 }], ['pro', 'program'], 'stage', 'amount');
  assert.equal(stages.pro.visits, 0);
  assert.equal(stages.program.visits, 1);
  assert.equal(stages.program.revenue_cents, 900);
  const ambiguous = reduceStageMeasures([{ stage: 'pro', amount: 900 }], ['one:pro', 'two:pro'], 'stage', 'amount');
  assert.equal(ambiguous['one:pro'].visits + ambiguous['two:pro'].visits, 0);
});

test('the conversion percent is the list engine share, equal to the rounding it replaced for every visits and conversions up to 80 (an exact half goes to the even tenth, as the engine rounds)', () => {
  for (let visits = 1; visits <= 80; visits += 1) for (let conversions = 0; conversions <= visits; conversions += 1) {
    const facts = Array.from({ length: visits }, (_, place) => (place < conversions ? { s: 'a', converted: true } : { s: 'a' }));
    const tenths = (conversions * 1000) / visits;
    const half = Number.isInteger(tenths * 2) && !Number.isInteger(tenths);
    const expected = (half ? (Math.floor(tenths) % 2 === 0 ? Math.floor(tenths) : Math.ceil(tenths)) : Math.round(tenths)) / 10;
    assert.equal(reduceStageMeasures(facts, ['a'], 's', 'cents').a.conversion_rate, expected, `${conversions} of ${visits}`);
  }
});

test('the counts and the revenue are the list engine measures: no tally is kept in the file', () => {
  const source = readFileSync(new URL('../read-data/stage-measures.mjs', import.meta.url), 'utf8');
  assert.match(source, /from 'trillion-workshop\/tools\/query-and-change-list-rows\/src\/list-aggregates\.mjs'/);
  assert.doesNotMatch(source, /\+= 1|revenue_cents \+=|Math\.round/);
  const funnel = readFileSync(new URL('../do-work/measure-funnel-stages.mjs', import.meta.url), 'utf8');
  assert.match(funnel, /aggregateOf\('sum'\)/);
  assert.doesNotMatch(funnel, /\.reduce\(/);
});
