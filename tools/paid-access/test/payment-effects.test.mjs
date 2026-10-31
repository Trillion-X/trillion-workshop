// Payment events through rule data into effects (ported from the cases in the old signed-event-effects tests that
// were about the projection: a payment event gives one effect, a duplicate is one effect, an unknown kind or an
// incomplete event gives none). The verifier, the write path and the descriptor guards were the old engine's. Every
// value is made up (a bakery selling a bread class).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import defaults from '../read-data/take-payments-events.json' with { type: 'json' };
import { effectsFromPaymentEvents, eventOfPaymentEvent } from '../read-data/payment-effects.mjs';

const event = (kind, attributes = {}, over = {}) => ({
  event_id: 'evt_1', event_kind: kind, occurred_at: '2026-01-05T00:00:00.000Z',
  attributes: { provider_event_id: 'evt_1', customer_email: 'ana@example.com', offer_id: 'offer:bread-class', ...attributes }, ...over,
});

test('a payment event becomes one effect on the buyer, with its facts as material', () => {
  const { effects, problems } = effectsFromPaymentEvents([event('subscription.ended', { provider_object_ref: 'sub_1' })], defaults.effect_rules);
  assert.deepEqual(problems, []);
  assert.equal(effects.length, 1);
  assert.deepEqual([effects[0].kind, effects[0].subject, effects[0].object, effects[0].material.provider_object_ref], ['subscription.ended', 'ana@example.com', 'offer:bread-class', 'sub_1']);
  assert.equal(effects[0].material.occurred_at, '2026-01-05T00:00:00.000Z');
  assert.deepEqual(effects[0].source_event_ids, ['evt_1']);
  assert.equal(effects[0].effect_id, 'subscription_ended:evt_1:evt_1');
});

test('the same event twice is one effect, and two events never share an effect id', () => {
  assert.equal(effectsFromPaymentEvents([event('payment.confirmed'), event('payment.confirmed')], defaults.effect_rules).effects.length, 1);
  const two = effectsFromPaymentEvents([event('payment.confirmed'), event('payment.confirmed', { provider_event_id: 'evt_2' }, { event_id: 'evt_2' })], defaults.effect_rules).effects;
  assert.deepEqual(two.map(effect => effect.effect_id).sort(), ['payment_confirmed:evt_1:evt_1', 'payment_confirmed:evt_2:evt_2']);
});

test('an event kind no rule reads, or one missing a required attribute, gives no effect', () => {
  assert.deepEqual(effectsFromPaymentEvents([event('payment.disputed')], defaults.effect_rules).effects, []);
  const noProviderEvent = event('payment.confirmed');
  delete noProviderEvent.attributes.provider_event_id;
  assert.deepEqual(effectsFromPaymentEvents([noProviderEvent], defaults.effect_rules).effects, []);
});

test('a subject or object that cannot be read skips that effect and says why; the other events still give theirs', () => {
  const rules = [{ rule_id: 'by-buyer-ref', relation: 'payment.confirmed', effect_kind: 'payment.confirmed', subject: { from: 'attribute', key: 'buyer_ref' }, object: { from: 'attribute', key: 'offer_id' } }];
  const named = event('payment.confirmed', { buyer_ref: 'buyer-9' }, { event_id: 'evt_2' });
  const { effects, problems } = effectsFromPaymentEvents([event('payment.confirmed'), named], rules);
  assert.deepEqual(effects.map(effect => effect.subject), ['buyer-9']);
  assert.equal(problems.length, 1);
  assert.deepEqual([problems[0].event_id, problems[0].rule_id], ['evt_1', 'by-buyer-ref']);
  assert.match(problems[0].problem, /subject cannot be read/);
});

test('a payment event without an id, a kind or a time is a problem, never an effect', () => {
  assert.equal(eventOfPaymentEvent({ event_id: 'e', event_kind: 'payment.confirmed' }), null);
  const { effects, problems } = effectsFromPaymentEvents([{ event_kind: 'payment.confirmed', occurred_at: '2026-01-01T00:00:00Z' }, 'not a record'], defaults.effect_rules);
  assert.deepEqual(effects, []);
  assert.equal(problems.length, 2);
});

test('a rule is data: another relation name, constants, a fallback chain and excluded attributes work with no code change', () => {
  const rules = [{
    rule_id: 'gift', relations: ['gift.sent', 'gift.resent'], effect_kind: 'license_access', effect_id_prefix: 'gift',
    subject: { from: 'attribute', key: 'to', fallback: { from: 'attribute', key: 'to_email' } },
    object: 'access:bread-basics',
    material: { constants: { grant_ref: 'grant:gift' }, include_attributes: false, include_event_fields: ['occurred_at'] },
  }];
  const gift = { event_id: 'g1', event_kind: 'gift.resent', occurred_at: '2026-02-01T00:00:00Z', attributes: { to_email: 'bo@example.com', secret_note: 'x' } };
  const [effect] = effectsFromPaymentEvents([gift], rules).effects;
  assert.deepEqual([effect.kind, effect.subject, effect.object, effect.material], ['license_access', 'bo@example.com', 'access:bread-basics', { grant_ref: 'grant:gift', occurred_at: '2026-02-01T00:00:00Z' }]);
});

test('the starter rules name event kinds and attributes only, no offer, price or person', () => {
  const text = JSON.stringify({ rules: defaults.effect_rules, lifecycle: defaults.lifecycle });
  assert.doesNotMatch(text, /@|\$|amount|price/i);
  assert.deepEqual(defaults.effect_rules.map(rule => rule.relation).sort(), ['payment.confirmed', 'payment.refunded', 'subscription.ended', 'subscription.renewed']);
});
