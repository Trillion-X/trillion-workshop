// Who holds which paid access now, end to end over rows in hand and over a stand-in records door. The payment events
// are the shape tools/take-payments keeps. Every name, address and amount here is made up (a bakery's bread class).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldAccess, heldAccessRefsOf, readHeldAccess } from '../read-data/who-holds-access.mjs';

const offers = [
  { id: 'offer:crumbs', access_refs: ['access:recipes-free'], price_options: [] },
  { id: 'offer:class', access_refs: ['access:bread-class'], price_options: [{ id: 'p:c', amount_cents: 9000 }] },
  { id: 'offer:club', access_refs: ['access:bread-club'], price_options: [{ id: 'p:b', amount_cents: 1500 }] },
];
const bought = (id, at, who, attributes) => ({ event_id: id, event_kind: 'payment.confirmed', occurred_at: at, attributes: { provider_event_id: id, customer_email: who, payment_status: 'paid', ...attributes } });
const ana = 'ana@example.com';
const bo = 'bo@example.com';
const classBought = bought('evt_1', '2026-03-01T10:00:00Z', ana, { offer_id: 'offer:class', payment_intent_ref: 'pi_1' });
const clubBought = bought('evt_2', '2026-03-02T10:00:00Z', ana, { offer_id: 'offer:club', subscription_id: 'sub_1' });
const clubRenewed = { event_id: 'evt_3', event_kind: 'subscription.renewed', occurred_at: '2026-04-02T10:00:00Z', attributes: { provider_event_id: 'evt_3', customer_email: ana, provider_object_ref: 'sub_1' } };
const clubEnded = { event_id: 'evt_4', event_kind: 'subscription.ended', occurred_at: '2026-05-02T10:00:00Z', attributes: { provider_event_id: 'evt_4', provider_object_ref: 'sub_1' } };
const classRefunded = { event_id: 'evt_5', event_kind: 'payment.refunded', occurred_at: '2026-03-05T10:00:00Z', attributes: { provider_event_id: 'evt_5', provider_object_ref: 'ch_1', payment_intent_ref: 'pi_1' } };
const NOW = Date.parse('2026-06-01T00:00:00Z');

test('what a buyer bought, plus what is free for everyone, is what they hold; an anonymous list never holds a paid ref', () => {
  const answer = heldAccess({ subject: ana, nowMs: NOW, paymentEvents: [classBought, clubBought, clubRenewed], offers });
  assert.deepEqual(answer.held_access_refs, ['access:bread-class', 'access:bread-club', 'access:recipes-free']);
  assert.deepEqual(answer.active_offers.sort(), ['offer:class', 'offer:club', 'offer:crumbs']);
  assert.deepEqual(heldAccess({ subject: bo, nowMs: NOW, paymentEvents: [classBought, clubBought], offers }).held_access_refs, ['access:recipes-free']);
});

test('a cancellation or a refund that names only its own provider reference ends the access it belongs to', () => {
  const answer = heldAccess({ subject: ana, nowMs: NOW, paymentEvents: [classBought, clubBought, clubRenewed, clubEnded, classRefunded], offers });
  assert.deepEqual(answer.held_access_refs, ['access:recipes-free']);
  assert.deepEqual(answer.episodes.map(episode => [episode.episode_ref, episode.state]).sort(), [['pi_1', 'ended'], ['sub_1', 'ended']]);
});

test('events arriving in any order give the same answer', () => {
  const events = [classBought, clubBought, clubRenewed, clubEnded, classRefunded];
  const first = JSON.stringify(heldAccess({ subject: ana, nowMs: NOW, paymentEvents: events, offers }));
  assert.equal(JSON.stringify(heldAccess({ subject: ana, nowMs: NOW, paymentEvents: [...events].reverse(), offers })), first);
});

test('a grant the person wrote counts while its window is open, an end ends it, and another buyer\'s grant is not mine', () => {
  const gift = { kind: 'license_access', subject: bo, object: 'access:bread-class', material: { grant_ref: 'grant:gift', valid_from_ms: Date.parse('2026-05-01T00:00:00Z'), expires_at_ms: Date.parse('2026-07-01T00:00:00Z') } };
  const lasting = { kind: 'license_access', subject: bo, object: 'access:bread-club', material: { grant_ref: 'grant:comp' } };
  const revoke = { kind: 'revoke', subject: bo, material: { revokes_grant_ref: 'grant:comp' } };
  const during = heldAccess({ subject: bo, nowMs: NOW, grants: [gift, lasting], offers });
  assert.deepEqual(during.granted_access_refs, ['access:bread-class', 'access:bread-club']);
  assert.deepEqual(heldAccess({ subject: bo, nowMs: Date.parse('2026-07-01T00:00:00Z'), grants: [gift, lasting], offers }).granted_access_refs, ['access:bread-club'], 'a window ends exactly at its end');
  assert.deepEqual(heldAccess({ subject: bo, nowMs: NOW, grants: [gift, lasting, revoke], offers }).granted_access_refs, ['access:bread-class']);
  assert.deepEqual(heldAccess({ subject: ana, nowMs: NOW, grants: [gift, lasting], offers }).granted_access_refs, []);
});

test('a purchase and a grant of the same access hold it once', () => {
  const grant = { kind: 'license_access', subject: ana, object: 'access:bread-class', material: { grant_ref: 'grant:x' } };
  assert.deepEqual(heldAccess({ subject: ana, nowMs: NOW, paymentEvents: [classBought], grants: [grant], offers }).held_access_refs, ['access:bread-class', 'access:recipes-free']);
});

test('events that give no effect are named in problems, and a person\'s own rule and lifecycle replace the starter ones', () => {
  const answer = heldAccess({ subject: ana, nowMs: NOW, paymentEvents: [{ event_kind: 'payment.confirmed' }, classBought], offers });
  assert.equal(answer.problems.length, 1);
  const rules = [{ rule_id: 'buy', relation: 'order.paid', effect_kind: 'order.paid', subject: { from: 'attribute', key: 'who' }, object: { from: 'attribute', key: 'offer_id' } }];
  const lifecycle = { episode_keys: ['order'], transitions: [{ effect_kind: 'order.paid', to: 'active' }] };
  const order = { event_id: 'o1', event_kind: 'order.paid', occurred_at: '2026-03-01T00:00:00Z', attributes: { who: 'cy', offer_id: 'offer:class', order: 'order-7' } };
  assert.deepEqual(heldAccess({ subject: 'cy', nowMs: NOW, paymentEvents: [order], offers, rules, lifecycle }).held_access_refs, ['access:bread-class', 'access:recipes-free']);
});

test('a buyer must be named', () => {
  assert.throws(() => heldAccess({ subject: ' ', nowMs: NOW }), /subject must name the buyer/);
});

// A stand-in door: records by type, listed as the door lists them.
const doorOf = (byType, { failOn } = {}) => ({
  async *list({ type }) {
    if (type === failOn) throw new Error('the records cannot be reached');
    for (const [index, value] of (byType[type] ?? []).entries()) yield { id: `${type}:${index}`, type, value };
  },
});

test('rows the request does not carry are listed from the person\'s records; rows it carries replace them', async () => {
  const door = doorOf({ 'payment-event': [classBought], 'commercial-offer': offers });
  assert.deepEqual((await readHeldAccess({ subject: ana }, { door, nowMs: NOW })).held_access_refs, ['access:bread-class', 'access:recipes-free']);
  assert.deepEqual((await readHeldAccess({ subject: ana, payment_events: [] }, { door, nowMs: NOW })).held_access_refs, ['access:recipes-free']);
  assert.deepEqual(await heldAccessRefsOf(ana, { door, nowMs: NOW }), ['access:bread-class', 'access:recipes-free']);
});

test('a record kind that cannot be read is an error, never "holds nothing"', async () => {
  await assert.rejects(readHeldAccess({ subject: ana }, { door: doorOf({}, { failOn: 'payment-event' }), nowMs: NOW }), /cannot be reached/);
});
