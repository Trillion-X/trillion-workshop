// A person's access is exactly what their payment effects say now: a purchase starts an episode, a renewal keeps it,
// a cancellation or refund ends it, and the offer row says which capabilities an active episode gives. The first four
// cases are the old capability-effect-lifecycle tests (its installed lifecycle is read-data/take-payments-events.json
// here); the last two are new: one person's episodes only, and an effect on another address still ends an episode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import defaults from '../read-data/take-payments-events.json' with { type: 'json' };
import { currentCapabilityState, observedLifecycleFactSet } from '../read-data/effect-lifecycle.mjs';

const lifecycle = defaults.lifecycle;
const offers = [
  { id: 'offer:free', access_refs: ['access:method'], price_options: [] },
  { id: 'offer:member', access_refs: ['access:history', 'access:others'], price_options: [{ id: 'p:m', amount_cents: 10000 }] },
  { id: 'offer:session', access_refs: ['access:session'], price_options: [{ id: 'p:s', amount_cents: 150000 }] },
];
let n = 0;
const effect = (kind, at, material, subject = 'person-a') => ({ effect_id: `e${n += 1}`, kind, subject, object: material.offer_id ?? 'x', material: { occurred_at: at, ...material } });

test('a paid subscription gives its offer\'s capabilities, a free offer is held by everyone', () => {
  const state = currentCapabilityState({ offers, lifecycle, effects: [effect('payment.confirmed', '2026-09-01', { offer_id: 'offer:member', subscription_id: 'sub_1', payment_status: 'paid' })] });
  assert.deepEqual(state.capabilities, ['access:history', 'access:method', 'access:others']);
  assert.deepEqual(currentCapabilityState({ offers, lifecycle, effects: [] }).capabilities, ['access:method']);
});

test('a cancellation ends the episode even when it arrives before the purchase, and a renewal without an offer keeps the episode\'s offer', () => {
  const bought = effect('payment.confirmed', '2026-09-01T00:00:00Z', { offer_id: 'offer:member', subscription_id: 'sub_1', payment_status: 'paid' });
  const renewed = effect('subscription.renewed', '2026-10-01T00:00:00Z', { provider_object_ref: 'sub_1' });
  const ended = effect('subscription.ended', '2026-10-15T00:00:00Z', { provider_object_ref: 'sub_1' });
  assert.deepEqual(currentCapabilityState({ offers, lifecycle, effects: [ended, renewed, bought] }).capabilities, ['access:method']);
  const [episode] = observedLifecycleFactSet({ lifecycle, effects: [renewed, bought] });
  assert.deepEqual([episode.offer_id, episode.state, episode.events.length], ['offer:member', 'active', 2]);
});

test('an unpaid checkout starts nothing, a refund ends a one-time purchase, and an unknown effect kind changes nothing', () => {
  const unpaid = effect('payment.confirmed', '2026-09-01', { offer_id: 'offer:session', payment_intent_ref: 'pi_1', payment_status: 'unpaid' });
  assert.deepEqual(currentCapabilityState({ offers, lifecycle, effects: [unpaid] }).active_offers, ['offer:free']);
  const paid = effect('payment.confirmed', '2026-09-02', { offer_id: 'offer:session', payment_intent_ref: 'pi_1', payment_status: 'paid' });
  assert.ok(currentCapabilityState({ offers, lifecycle, effects: [paid] }).capabilities.includes('access:session'));
  const refunded = effect('payment.refunded', '2026-09-03', { payment_intent_ref: 'pi_1', provider_object_ref: 'ch_1' });
  const disputed = effect('payment.disputed', '2026-09-04', { payment_intent_ref: 'pi_1' });
  assert.ok(!currentCapabilityState({ offers, lifecycle, effects: [paid, refunded] }).capabilities.includes('access:session'));
  assert.ok(currentCapabilityState({ offers, lifecycle, effects: [paid, disputed] }).capabilities.includes('access:session'));
});

test('an allowance limits a capability only while no active offer grants it without one', () => {
  const allowanceOffers = [
    { id: 'offer:free', access_refs: ['access:method'], allowances: [{ access: 'access:method', count: 5, per: 'month' }], price_options: [] },
    { id: 'offer:member', access_refs: ['access:method', 'access:history'], price_options: [{ id: 'p:m', amount_cents: 10000 }] },
  ];
  const free = currentCapabilityState({ effects: [], offers: allowanceOffers, lifecycle });
  assert.deepEqual(free.limits, { 'access:method': [{ count: 5, per: 'month' }] });
  const paid = currentCapabilityState({ effects: [{ effect_id: 'e1', kind: 'payment.confirmed', material: { subscription_id: 'sub_1', offer_id: 'offer:member', payment_status: 'paid', occurred_at: '2026-09-01T00:00:00Z' } }], offers: allowanceOffers, lifecycle });
  assert.deepEqual(paid.limits, {}, 'the paid offer grants the same access without a limit');
});

test('with a subject, only that person\'s episodes count, judged on the effect that started each', () => {
  const a = effect('payment.confirmed', '2026-09-01', { offer_id: 'offer:member', subscription_id: 'sub_a', payment_status: 'paid' }, 'person-a');
  const b = effect('payment.confirmed', '2026-09-01', { offer_id: 'offer:session', payment_intent_ref: 'pi_b', payment_status: 'paid' }, 'person-b');
  assert.deepEqual(currentCapabilityState({ offers, lifecycle, effects: [a, b], subject: 'person-a' }).capabilities, ['access:history', 'access:method', 'access:others']);
  assert.deepEqual(currentCapabilityState({ offers, lifecycle, effects: [a, b], subject: 'person-b' }).capabilities, ['access:method', 'access:session']);
  assert.deepEqual(currentCapabilityState({ offers, lifecycle, effects: [a, b], subject: 'person-c' }).capabilities, ['access:method']);
});

test('a refund that names only its own reference (another subject) still ends the episode it belongs to', () => {
  const paid = effect('payment.confirmed', '2026-09-02', { offer_id: 'offer:session', payment_intent_ref: 'pi_1', payment_status: 'paid' });
  const refunded = effect('payment.refunded', '2026-09-03', { payment_intent_ref: 'pi_1' }, 'ch_1');
  assert.ok(!currentCapabilityState({ offers, lifecycle, effects: [paid, refunded], subject: 'person-a' }).capabilities.includes('access:session'));
});

test('a lifecycle row without transitions is refused', () => {
  assert.throws(() => observedLifecycleFactSet({ effects: [], lifecycle: {} }), /lifecycle row with transitions/);
});
