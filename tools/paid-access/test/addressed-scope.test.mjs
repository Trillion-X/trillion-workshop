// Whether a buyer may open one gated thing (ported from the old product-access scope-authorization cases, with the
// hosted carrier's identity, session, operation and byte encodings gone). Every value is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESSED_EXPIRING_VALUE_SCOPE_SCHEMA, decodeAddressedExpiringValueScope } from '../read-data/addressed-scope.mjs';
import { checkABuyerMayOpen } from '../do-work/paid-access.mjs';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const scope = (required = [], over = {}) => ({ schema: ADDRESSED_EXPIRING_VALUE_SCOPE_SCHEMA, value_ref: 'page:bread-class', instance_ref: 'page:bread-class:spring', required_access_refs: required, ...over });
const door = (events, offers = []) => ({
  async *list({ type }) { for (const value of type === 'payment-event' ? events : type === 'commercial-offer' ? offers : []) yield { id: 'r', type, value }; },
});
const offers = [{ id: 'offer:class', access_refs: ['access:bread-class'], price_options: [{ amount_cents: 9000 }] }];
const paid = { event_id: 'evt_1', event_kind: 'payment.confirmed', occurred_at: '2026-03-01T00:00:00Z', attributes: { provider_event_id: 'evt_1', customer_email: 'ana@example.com', offer_id: 'offer:class', payment_intent_ref: 'pi_1', payment_status: 'paid' } };
const refunded = { event_id: 'evt_2', event_kind: 'payment.refunded', occurred_at: '2026-03-02T00:00:00Z', attributes: { provider_event_id: 'evt_2', provider_object_ref: 'ch_1', payment_intent_ref: 'pi_1' } };
const ask = (input, ctx) => checkABuyerMayOpen(input, { nowMs: NOW, ...ctx });

test('a thing that requires nothing is open to any named buyer, with no access looked up', async () => {
  const unreadable = { async *list() { throw new Error('must not be read'); } };
  assert.deepEqual(await ask({ subject: 'anyone', scope: scope() }, { door: unreadable }), { authorized: true });
  assert.deepEqual(await ask({ subject: ' ', scope: scope() }, { door: unreadable }), { authorized: false });
});

test('a gated thing opens on ANY intersection with what the buyer holds, and a refund closes it on the next ask', async () => {
  const gated = scope(['access:other', 'access:bread-class', 'access:bread-class']);
  assert.deepEqual(await ask({ subject: 'ana@example.com', scope: gated }, { door: door([paid], offers) }), { authorized: true });
  assert.deepEqual(await ask({ subject: 'bo@example.com', scope: gated }, { door: door([paid], offers) }), { authorized: false });
  assert.deepEqual(await ask({ subject: 'ana@example.com', scope: gated }, { door: door([paid, refunded], offers) }), { authorized: false });
});

test('access that cannot be worked out is not authorized, and the answer says nothing else', async () => {
  const broken = { async *list() { throw new Error('private detail'); } };
  const answer = await ask({ subject: 'ana@example.com', scope: scope(['access:bread-class']) }, { door: broken });
  assert.deepEqual(answer, { authorized: false });
});

test('a scope that is not exactly the schema is refused: unknown schema, unknown field, bad refs, oversize, not JSON', () => {
  const refused = [
    scope([], { schema: 'surface-scope/v1' }), scope([], { browser_grants: ['access:forged'] }), scope([], { surface_ref: 'x' }),
    scope([1]), scope(['']), scope([], { value_ref: '' }), scope(Array.from({ length: 129 }, (_, i) => `access:${i}`)),
    scope([], { value_ref: 'x'.repeat(4097) }), '{', '', null, [], 7,
  ];
  for (const value of refused) assert.equal(decodeAddressedExpiringValueScope(value), null, JSON.stringify(value)?.slice(0, 60));
});

test('one value_ref contract serves a page, a publication and a thing no one has named yet; JSON text decodes too', () => {
  for (const valueRef of ['page:bread-class', 'publication:starter-plan:v1', 'future-value:sourdough-log']) {
    assert.deepEqual(decodeAddressedExpiringValueScope(scope([], { value_ref: valueRef })), scope([], { value_ref: valueRef }));
  }
  assert.deepEqual(decodeAddressedExpiringValueScope(JSON.stringify(scope(['access:a']))), scope(['access:a']));
});

test('a buyer\'s own claim of access is not read: only the scope and the subject are', async () => {
  const answer = await ask({ subject: 'bo@example.com', scope: scope(['access:bread-class']), granted_access_refs: ['access:bread-class'] }, { door: door([], offers) });
  assert.deepEqual(answer, { authorized: false });
});
