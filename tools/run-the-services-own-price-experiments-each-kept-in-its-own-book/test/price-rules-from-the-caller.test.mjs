// A price rule a caller hands in reaches an experiment that carries none of its own: the experiment gets the rule's reading in
// its results, and a caller that hands in an empty rules list gets none. The rule and the experiment come from the caller
// (the shared tool holds no name of the person's own), so the fixtures here are made up. The rule is read; no price a person
// is shown changes, because the arms are the owner's offers and the owner never re-prices them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePriceExperiments } from '../web/src/price-experiments.mjs';

const RULE = {
  mode: 'controller', start_cents: 10000, floor_cents: 5000, sales_to_double: 1, target_win_rate: 0.05,
  currency: 'usd', interval: 'month', suggested_multiples: [1, 1.5, 2],
};
const EXPERIMENT = {
  id: 'experiment:sample-plan', kind: 'price-experiment', label: 'Sample plan', surface: 'sample', optimizing_for: 'Money collected per person shown the plan.',
  state: 'running', arms: [
    { id: 'offer:sample-100', label: '$100 a month', weight: 1, offer_id: 'offer:sample-100', amount_cents: 10000, currency: 'usd', interval: 'month' },
    { id: 'offer:sample-50', label: '$50 a month', weight: 1, offer_id: 'offer:sample-50', amount_cents: 5000, currency: 'usd', interval: 'month' },
  ],
};

function book(rules) {
  const kept = new Map([[`price-experiment:${EXPERIMENT.id}`, structuredClone(EXPERIMENT)]]);
  return makePriceExperiments({
    store: { list: () => [...kept.values()], put: (entity, value) => kept.set(entity, value) },
    recordEvent: () => {},
    eventsOf: () => [],
    offers: async () => null,
    rules,
  });
}

test('a rule the caller hands in is read for an experiment with no rule of its own: the price starts at its start and the suggestions are its multiples', async () => {
  const { geometric } = await book([{ applies_to: EXPERIMENT.id, rule: RULE }]).results({ experiment_id: EXPERIMENT.id });
  assert.ok(geometric, 'the handed-in rule is read');
  assert.equal(geometric.mode, 'controller');
  assert.equal(geometric.price_cents, 10000);
  assert.deepEqual(geometric.suggested_cents, [10000, 15000, 20000]);
});

test('a caller that hands in an empty rules list gets no rule reading for that experiment', async () => {
  const { geometric } = await book([]).results({ experiment_id: EXPERIMENT.id });
  assert.equal(geometric, undefined);
});
