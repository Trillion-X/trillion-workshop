// The arm an observer is shown is the one the old sticky_hash split chose for them, every time: these pins were read from
// the old scorer (parts/choose-per-observer) over the live experiments. Shown offers keep an arm only for who is shown it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import live from '../read-data/live-experiments.json' with { type: 'json' };
import { assignArm, assignArms, shownOffers } from '../read-data/price-arms.mjs';

const [siteMonthly, plan] = live;
const open = () => true;

test('the live DATA holds the two running experiments with their weights and offers', () => {
  assert.deepEqual(live.map(experiment => experiment.surface), ['hosted-site', 'paid-plan']);
  assert.deepEqual(live.map(experiment => experiment.state), ['running', 'running']);
  assert.equal(plan.arms.find(arm => arm.id === 'offer:trillion-spot-50').weight, 6);
  assert.equal(plan.arms.find(arm => arm.id === 'offer:trillion').weight, 0);
});

test('an observer keeps the same arm of each running experiment', () => {
  assert.equal(assignArm('visitor-1', siteMonthly, open), 'offer:hosted-site-monthly-900');
  assert.equal(assignArm('visitor-1', plan, open), 'offer:trillion-five-today');
  assert.equal(assignArm('acct_42', siteMonthly, open), 'offer:hosted-site-monthly-1900');
  assert.equal(assignArm('acct_42', plan, open), 'offer:trillion-ten-today');
  assert.equal(assignArm('visitor-abc', plan, open), 'offer:trillion-two-today');
  assert.equal(assignArm('ana@example.com', siteMonthly, open), 'offer:hosted-site-monthly-1900');
  assert.equal(assignArm('ana@example.com', plan, open), 'offer:trillion-five-today');
});

test('a weight-zero arm and an arm that is not open are never shown', () => {
  const notOpen = arm => arm.offer_id !== 'offer:trillion-spot-50';
  for (let n = 0; n < 500; n++) {
    const shown = assignArm(`v${n}`, plan, notOpen);
    assert.notEqual(shown, 'offer:trillion');
    assert.notEqual(shown, 'offer:trillion-spot-50');
  }
});

test('a stopped experiment shows none of its arms, and assignArms keys each arm by its surface', () => {
  assert.equal(assignArm('visitor-1', { ...plan, state: 'stopped' }, open), null);
  assert.deepEqual(Object.keys(assignArms('visitor-1', live, open)), ['hosted-site', 'paid-plan']);
});

test('shown offers drop an arm offer unless it is the observer arm or the observer holds it', () => {
  const offers = [{ id: 'offer:trillion-five-today' }, { id: 'offer:trillion-ten-today' }, { id: 'offer:one-on-one-with-Avery' }];
  const kept = shownOffers({ offers, experiments: live, chosen: ['offer:trillion-five-today'] });
  assert.deepEqual(kept.map(offer => offer.id), ['offer:trillion-five-today', 'offer:one-on-one-with-Avery']);
  const held = shownOffers({ offers, experiments: live, holds: offer => offer.id === 'offer:trillion-ten-today' });
  assert.deepEqual(held.map(offer => offer.id), ['offer:trillion-ten-today', 'offer:one-on-one-with-Avery']);
});
