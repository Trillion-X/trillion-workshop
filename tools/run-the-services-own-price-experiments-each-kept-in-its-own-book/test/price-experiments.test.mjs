// A price experiment is one record shape any account runs on its own offers (tool:run-price-experiments): arms read
// their price from the account's offers, an observer keeps one arm, payments count once per arm, a settled one shows its
// winner to everyone, and any typed variant (not only a price) runs through the same assignment, events and results.
//
// Ported from the old repository's test/price-experiments.test.mjs (commit b6ae0ebf81, 160 lines, 6 tests), which the move left
// behind. Tests 1, 2, 5 and 6 are here with every assertion unchanged. Left out: 'the funnel graph counts an experiment's
// events ...' (its events were kept by old src/commercial-events.mjs, which is now workflow:keep-commercial-events-once;
// the funnel reader is tools/workspace-screens/web/src/funnel-read.mjs) and 'the money tools are account actions ...'
// (it read old records/workshop-money-tool-records.json; tool:run-price-experiments has no row here, see the research
// row verify-every-port/run-the-services-own-price-experiments-each-kept-in-its-own-book). Events are kept in memory,
// the same way a caller that keeps them in its own records would hand them: one record per event id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePriceExperiments, shownOffers } from '../web/src/price-experiments.mjs';

function account({ offers = null } = {}) {
  const kept = new Map();
  const events = new Map();
  const experiments = makePriceExperiments({
    store: { list: () => [...kept.values()], put: (entity, value) => kept.set(entity, value) },
    recordEvent: event => { events.set(event.event_id ?? `${events.size}`, event); },
    eventsOf: id => [...events.values()].filter(event => event.experiment_id === id),
    offers: async () => offers,
  });
  return { experiments };
}

// Two prices of one sourdough tin on the seller's own payment service, as the contract builder reads them.
const TINS = new Map([
  ['price_tin_12', { label: 'Riverside Bakery tin', amount_cents: 1200, currency: 'usd', interval: null, price_id: 'price_tin_12' }],
  ['price_tin_16', { label: 'Riverside Bakery tin', amount_cents: 1600, currency: 'usd', interval: null, price_id: 'price_tin_16' }],
  ['price_gift_box', { label: 'Gift box', amount_cents: 4000, currency: 'usd', interval: null, price_id: 'price_gift_box' }],
]);

test('an account tests its own prices: arms read their price from its offers, an observer keeps one arm, payments count per arm', async () => {
  const { experiments } = account({ offers: TINS });
  await assert.rejects(experiments.save({ label: 'Tin price', arms: [{ price_id: 'price_tin_12' }] }), /at least two arms/);
  await assert.rejects(experiments.save({ label: 'Tin price', arms: [{ price_id: 'price_tin_12' }, { price_id: 'price_nope' }] }), /not one of this account's offers/);
  const { experiment, said } = await experiments.save({ label: 'Tin price', funnel_id: 'sourdough-funnel', node_ref: 'tin', arms: [{ price_id: 'price_tin_12', amount_cents: 1 }, { price_id: 'price_tin_16' }] });
  assert.equal(experiment.id, 'experiment:tin-price');
  assert.deepEqual(experiment.arms.map(arm => arm.amount_cents), [1200, 1600], 'the offer\'s own price wins over a typed one');
  assert.match(said, /Tin price is running/);

  const seen = new Map();
  for (let visitor = 0; visitor < 200; visitor += 1) {
    const shown = experiments.assign({ experiment_id: experiment.id, observer: `visitor-${visitor}` });
    assert.equal(experiments.assign({ experiment_id: experiment.id, observer: `visitor-${visitor}` }).arm, shown.arm, 'the same observer keeps their arm');
    seen.set(shown.arm, (seen.get(shown.arm) ?? 0) + 1);
  }
  assert.deepEqual([...seen.keys()].sort(), ['price_tin_12', 'price_tin_16'], 'both prices are shown');

  const buyer = 'visitor-3';
  const arm = experiments.assign({ experiment_id: experiment.id, observer: buyer }).arm;
  experiments.record({ experiment_id: experiment.id, observer: buyer, moment: 'paid', amount_cents: TINS.get(arm).amount_cents, event_id: 'pi_1', occurred_at: '2026-10-03T10:00:00Z' });
  experiments.record({ experiment_id: experiment.id, observer: buyer, moment: 'paid', amount_cents: TINS.get(arm).amount_cents, event_id: 'pi_1', occurred_at: '2026-10-03T10:00:00Z' });
  const results = await experiments.results({ experiment_id: experiment.id });
  const row = results.arms.find(item => item.arm === arm);
  assert.equal(results.arms.reduce((sum, item) => sum + item.shown, 0), 200, 'every observer shown a price counts once');
  assert.deepEqual([row.paid, row.money_cents], [1, TINS.get(arm).amount_cents], 'a payment sent twice counts once');
  assert.equal(results.leading, arm);

  const { offers } = await experiments.shown_offers({ observer: buyer });
  assert.deepEqual(offers.map(offer => offer.key).sort(), [arm, 'price_gift_box'].sort(), 'an observer is shown their own arm and every offer outside the experiment');

  const settled = await experiments.settle({ experiment_id: experiment.id });
  assert.deepEqual([settled.experiment.state, settled.experiment.result.winner], ['settled', arm], 'with no winner named, the leading arm wins');
  for (let visitor = 0; visitor < 20; visitor += 1) assert.equal(experiments.assign({ experiment_id: experiment.id, observer: `late-${visitor}` }).arm, arm, 'everyone is now shown the winner');
  await experiments.stop({ experiment_id: experiment.id });
  assert.equal(experiments.assign({ experiment_id: experiment.id, observer: 'after-stop' }).arm, null, 'a stopped experiment shows no price');
});

test('a price sold elsewhere can be tested without a connected payment service', async () => {
  const { experiments } = account();
  const { experiment } = await experiments.save({ label: 'Workshop seat', arms: [{ id: 'seat-49', amount_cents: 4900 }, { id: 'seat-79', amount_cents: 7900, weight: 0 }] });
  for (let visitor = 0; visitor < 30; visitor += 1) assert.equal(experiments.assign({ experiment_id: experiment.id, observer: `v${visitor}` }).arm, 'seat-49', 'a zero-weight arm is never shown');
  await assert.rejects(experiments.shown_offers({ observer: 'v1' }), /could not be read/);
});


test('shown offers hide every arm but the chosen one, and keep an offer the observer already holds', () => {
  const experiment = { id: 'e', state: 'running', arms: [{ id: 'a', offer_id: 'o-a' }, { id: 'b', offer_id: 'o-b' }] };
  const offers = [{ id: 'o-a' }, { id: 'o-b' }, { id: 'o-c' }];
  assert.deepEqual(shownOffers({ offers, experiments: [experiment], chosen: ['a'] }).map(offer => offer.id), ['o-a', 'o-c']);
  assert.deepEqual(shownOffers({ offers, experiments: [experiment], chosen: ['a'], holds: offer => offer.id === 'o-b' }).map(offer => offer.id), ['o-a', 'o-b', 'o-c']);
});

// An arm is any typed variant: a price is one kind (amount_cents, read from an offer), and anything else (an
// introduction's words, a send time, a title) is a `variant` the caller serves as it is. The same record, assignment,
// events and results run both; a variant arm's conversion counts one unit unless it brings a value of its own.
test('an experiment tests any typed variant, not only prices, through the same assignment, events and results', async () => {
  const { experiments } = account();
  await assert.rejects(experiments.save({ label: 'Intro words', arms: [{ id: 'plain' }, { id: 'warm' }] }), /amount_cents \(a price\) or variant/);
  await assert.rejects(experiments.save({ label: 'Mixed', arms: [{ id: 'cheap', amount_cents: 900 }, { id: 'warm', variant: { words: 'Hi' } }] }), /one kind/);
  const arms = ['plain', 'warm', 'short', 'evening'].map(id => ({ id, label: `Introduction ${id}`, variant: { kind: id === 'evening' ? 'timing' : 'words', value: id } }));
  const { experiment } = await experiments.save({ label: 'Intro words', optimizing_for: 'Introductions that lead to a talk', arms });
  assert.deepEqual(experiment.arms.map(arm => arm.variant.value), ['plain', 'warm', 'short', 'evening']);
  assert.ok(experiment.arms.every(arm => arm.amount_cents === undefined && arm.currency === undefined), 'a variant arm carries no price');
  const shown = experiments.assign({ experiment_id: experiment.id, observer: 'person-1' });
  assert.deepEqual(shown.variant, experiment.arms.find(arm => arm.id === shown.arm).variant, 'the caller is handed the variant to serve');
  for (let person = 0; person < 40; person += 1) experiments.assign({ experiment_id: experiment.id, observer: `person-${person}` });
  for (const person of [1, 2, 3]) experiments.record({ experiment_id: experiment.id, observer: `person-${person}`, moment: 'converted', event_id: `talk-${person}` });
  assert.throws(() => experiments.record({ experiment_id: experiment.id, observer: 'person-1', moment: 'paid', amount_cents: 100, event_id: 'pay-1' }), /moment is one of converted/);
  const results = await experiments.results({ experiment_id: experiment.id });
  assert.equal(results.arms.length, 4);
  assert.equal(results.arms.reduce((sum, arm) => sum + arm.converted, 0), 3);
  assert.equal(results.arms.reduce((sum, arm) => sum + arm.shown, 0), 40);
  assert.ok(results.arms.every(arm => arm.chance_best !== null), 'every arm has a chance of being best once anything converted');
  assert.ok(results.leading);
  const settled = await experiments.settle({ experiment_id: experiment.id });
  assert.equal(experiments.assign({ experiment_id: experiment.id, observer: 'someone-new' }).arm, settled.experiment.result.winner);
});
