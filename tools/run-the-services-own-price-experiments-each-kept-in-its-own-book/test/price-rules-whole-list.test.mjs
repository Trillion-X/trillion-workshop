// The DATA price rules a caller hands in are checked as one list before any is read, as the old published list was
// (the older Workshop copy's src/service-price-rules.mjs readServicePriceRules, commit b6ae0ebf81): a malformed row, a row naming no
// experiment, or two rows naming the same experiment refuses the whole list. An id is read trimmed. The rule and the
// experiment are made up here; nothing is sent and no price changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePriceExperiments } from '../web/src/price-experiments.mjs';

const RULE = { mode: 'controller', start_cents: 10000, floor_cents: 5000, sales_to_double: 1, target_win_rate: 0.05, currency: 'usd' };
const EXPERIMENT = {
  id: 'experiment:sample-plan', kind: 'price-experiment', label: 'Sample plan', surface: 'sample', optimizing_for: 'Money collected per person shown the plan.',
  state: 'running', arms: [
    { id: 'offer:sample-100', label: '$100 a month', weight: 1, offer_id: 'offer:sample-100', amount_cents: 10000, currency: 'usd', interval: 'month' },
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

test('a list with a row that is not an object, names no experiment, or names one twice is refused whole', async () => {
  const refused = /distinct experiment ids/;
  for (const rows of [
    [null],
    [{ rule: RULE }],
    [{ applies_to: '   ', rule: RULE }],
    [{ applies_to: EXPERIMENT.id, rule: RULE }, { applies_to: `  ${EXPERIMENT.id} `, rule: RULE }],
  ]) {
    await assert.rejects(book(rows).results({ experiment_id: EXPERIMENT.id }), refused);
  }
  await assert.rejects(book([{ applies_to: 'experiment:other', rule: RULE }, { applies_to: EXPERIMENT.id, rule: { ...RULE, target_win_rate: 1 } }]).results({ experiment_id: EXPERIMENT.id }), /target_win_rate must be between 0 and 1/);
});

test('a listed rule is read trimmed, and a list naming other experiments only reads no rule for this one', async () => {
  const { geometric } = await book([{ applies_to: `  ${EXPERIMENT.id} `, rule: RULE }]).results({ experiment_id: EXPERIMENT.id });
  assert.equal(geometric.price_cents, 10000);
  const none = await book([{ applies_to: 'experiment:other', rule: RULE }]).results({ experiment_id: EXPERIMENT.id });
  assert.equal(Object.hasOwn(none, 'geometric'), false);
});
