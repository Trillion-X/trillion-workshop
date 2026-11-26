// The payment catch-up's statements on a real Postgres (PGlite): a whole listed page is kept once by the same rules as one keep
// (keepPaymentEventSql), so the list keep and one-by-one keeps leave the same rows; a page read again keeps nothing; a payment
// kept by the webhook or under its older checkout id is not kept twice; and the saved point moves only after a complete read
// whose every event is kept, only ever forward. No key and no network: signed payloads and fake Stripe replies.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { checkAStripeEvent, listCompletedCheckoutsAsPaymentEvents } from '../do-work/take-payments.mjs';
import { keepPaymentEventSql, paymentEventsShape, paymentKindsOf } from '../do-work/payment-keys.ts';
import { CATCH_UP_POINT_SQL, CATCH_UP_SHAPE, CHECKOUT_WINDOW_SECONDS, KEEP_PAYMENT_EVENTS_SQL, SETTLE_CATCH_UP_SQL } from '../do-work/payment-catch-up.ts';

const NOW = 1_790_000_000;
const SECRET = 'whsec_payment_catch_up_fixture';
const offers = [{ kind: 'commercial-offer', id: 'offer:seat', label: 'Seat', access_refs: ['access:seat'], price_options: [{ id: 'price:seat', label: 'Seat', amount_cents: 29900, currency: 'usd', payment_timing: 'one_time' }] }];
const kinds = paymentKindsOf();

type Event = { id: string; event_id: string; event_kind: string; occurred_at: string; attributes: Record<string, unknown> };
type Sent = { method: string; url: string };

const oneTime = (id: string, paymentIntent: string, amount = 29900) => ({
  id, object: 'checkout.session', status: 'complete', created: NOW - 60, amount_total: amount, currency: 'usd', subscription: null,
  mode: 'payment', payment_intent: paymentIntent, payment_status: amount > 0 ? 'paid' : 'no_payment_required',
  customer_details: { email: 'buyer@example.test' }, metadata: { offer_id: 'offer:seat', price_option_id: 'price:seat' },
});
const subscription = (id: string, invoice: string) => ({ ...oneTime(id, '', 9900), mode: 'subscription', payment_intent: null, invoice, subscription: `sub_${id}` });

async function invoicePayments(request: Sent) {
  const invoice = new URL(request.url).searchParams.get('invoice') ?? '';
  return { data: [{ status: 'paid', payment: { payment_intent: invoice.replace(/^in_/, 'pi_') } }], has_more: false };
}
async function webhook(session: object): Promise<Event> {
  const payload = JSON.stringify({ id: `evt_${(session as { id: string }).id}`, type: 'checkout.session.completed', created: NOW - 60, data: { object: session } });
  const signature = createHmac('sha256', SECRET).update(`${NOW}.${payload}`, 'utf8').digest('hex');
  const checked = await checkAStripeEvent({ payload, signature_header: `t=${NOW},v1=${signature}`, now_seconds: NOW }, { secrets: { webhookSecret: SECRET }, send: invoicePayments });
  return checked.payment_event as Event;
}
async function checkoutList(sessions: object[]): Promise<Event[]> {
  const send = async (request: Sent) => (request.url.includes('/invoice_payments') ? invoicePayments(request) : { data: sessions, has_more: false });
  return (await listCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0, offers }, { send })).events as Event[];
}

async function store() {
  const db = new PGlite();
  for (const statement of [...paymentEventsShape(), ...CATCH_UP_SHAPE]) await db.exec(statement);
  await db.exec(`CREATE TABLE offers (id text PRIMARY KEY, label text NOT NULL)`);
  await db.exec(`INSERT INTO offers VALUES ('offer:seat', 'Seat')`);
  return db;
}
// The one parameter each statement takes, as the workflow step binds it (a JSON object).
const given = (value: object) => [JSON.stringify(value)];
const keepList = async (db: PGlite, events: Event[]) => (await db.query<{ listed: number; kept: number }>(KEEP_PAYMENT_EVENTS_SQL, given({ events, kinds }))).rows[0];
// A bigint is a string through node-pg and a number through PGlite: each is read as a number here.
const numberOr = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const settle = async (db: PGlite, events: Event[], complete: boolean, next: number) => {
  const [answer] = (await db.query<{ listed: number; moved: boolean; read_from_unix: unknown }>(SETTLE_CATCH_UP_SQL, given({ events, kinds, complete, next_read_from_unix: next }))).rows;
  return { ...answer, read_from_unix: numberOr(answer.read_from_unix) };
};
const keepOne = async (db: PGlite, event: Event) => { const { sql, params } = keepPaymentEventSql(event, kinds); return (await db.query<{ kept: number }>(sql, params)).rows[0].kept; };
const rows = async (db: PGlite) => (await db.query(`SELECT id, event_id, event_kind, offer_id, customer_email, amount_due_today_cents::text, provider_object_ref, completion_ref, attributes, pursuit_ids FROM payment_events ORDER BY id`)).rows;
const point = async (db: PGlite) => numberOr((await db.query<{ read_from_unix: unknown }>('SELECT read_from_unix FROM payment_catch_up WHERE id = 1')).rows[0]?.read_from_unix);
async function keepOldShaped(db: PGlite, checkout: string) {
  await db.query(`INSERT INTO payment_events (id, event_id, occurred_at, event_kind, offer_id, provider_object_ref, completion_ref, provider_event_id, attributes)
    VALUES ($1, $2, now(), 'payment.confirmed', 'offer:seat', $3, $3, $2, $4)`,
  [`payment-event:checkout:${checkout}`, `checkout:${checkout}`, checkout, JSON.stringify({ provider_object_ref: checkout, completion_ref: checkout })]);
}

describe('the payment catch-up', () => {
  it('keeps a listed page once, with the same rows one-by-one keeps leave, and keeps nothing when the page is read again', async () => {
    const page = await checkoutList([oneTime('cs_a', 'pi_a'), subscription('cs_b', 'in_b'), oneTime('cs_c', 'pi_c', 0)]);
    const listed = await store();
    assert.deepEqual(await keepList(listed, page), { listed: 3, kept: 3 });
    const oneByOne = await store();
    for (const event of page) assert.equal(await keepOne(oneByOne, event), 1);
    assert.deepEqual(await rows(listed), await rows(oneByOne));
    assert.deepEqual(await keepList(listed, page), { listed: 3, kept: 0 });
    assert.equal((await rows(listed)).length, 3);
  });

  it('a payment the webhook kept, or kept under its older checkout id, is not kept again by the list', async () => {
    const db = await store();
    assert.equal(await keepOne(db, await webhook(oneTime('cs_w', 'pi_w'))), 1);
    await keepOldShaped(db, 'cs_old');
    const page = await checkoutList([oneTime('cs_w', 'pi_w'), oneTime('cs_old', 'pi_old'), oneTime('cs_new', 'pi_new')]);
    assert.deepEqual(await keepList(db, page), { listed: 3, kept: 1 });
    assert.deepEqual((await rows(db)).map(row => row.id), ['payment-event:checkout:cs_old', 'payment-event:payment:pi_new', 'payment-event:payment:pi_w']);
  });

  it('one payment listed twice in a page (its webhook form and its list form) keeps the first only', async () => {
    const db = await store();
    const [listedForm] = await checkoutList([subscription('cs_twice', 'in_twice')]);
    const webhookForm = await webhook(subscription('cs_twice', 'in_twice'));
    assert.deepEqual(await keepList(db, [webhookForm, listedForm, webhookForm]), { listed: 3, kept: 1 });
    assert.equal((await rows(db)).length, 1);
  });

  it('a clash on a key that is not the payment\'s raises and keeps nothing of the page', async () => {
    const db = await store();
    const [first] = await checkoutList([oneTime('cs_one', 'pi_one')]);
    await keepOne(db, first);
    const [other] = await checkoutList([oneTime('cs_two', 'pi_two')]);
    const [third] = await checkoutList([oneTime('cs_three', 'pi_three')]);
    await assert.rejects(keepList(db, [third, { ...other, event_id: first.event_id }]), /payment_events_event_id_key/);
    assert.deepEqual((await rows(db)).map(row => row.id), ['payment-event:payment:pi_one'], 'the statement is one: nothing of the page was kept');
  });

  it('an empty page keeps nothing and still settles', async () => {
    const db = await store();
    assert.deepEqual(await keepList(db, []), { listed: 0, kept: 0 });
    assert.deepEqual(await settle(db, [], true, NOW), { listed: 0, moved: true, read_from_unix: NOW });
  });

  it('the point starts 48 hours back, moves after a complete page is kept, never back, and not for a cut-short read', async () => {
    const db = await store();
    const start = (await db.query<{ created_after_unix: unknown; next_read_from_unix: unknown; offers: unknown[] }>(CATCH_UP_POINT_SQL)).rows[0];
    const nowUnix = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(Number(start.created_after_unix) - (nowUnix - CHECKOUT_WINDOW_SECONDS)) < 5, 'no point yet: 48 hours back');
    assert.equal(start.created_after_unix, start.next_read_from_unix);
    assert.deepEqual(start.offers, [{ id: 'offer:seat', label: 'Seat' }]);
    const page = await checkoutList([oneTime('cs_p', 'pi_p')]);
    await keepList(db, page);
    assert.deepEqual(await settle(db, page, false, NOW), { listed: 1, moved: false, read_from_unix: null });
    assert.equal(await point(db), null, 'a cut-short read leaves the point');
    assert.equal((await settle(db, page, true, NOW)).moved, true);
    assert.equal(await point(db), NOW);
    await settle(db, page, true, NOW - 100);
    assert.equal(await point(db), NOW, 'never back');
    assert.equal(numberOr((await db.query<{ created_after_unix: unknown }>(CATCH_UP_POINT_SQL)).rows[0].created_after_unix), NOW);
  });

  it('a listed event with no kept row fails the settle and the point stays', async () => {
    const db = await store();
    const kept = await checkoutList([oneTime('cs_k', 'pi_k')]);
    await keepList(db, kept);
    await settle(db, kept, true, NOW);
    const [lost] = await checkoutList([oneTime('cs_lost', 'pi_lost')]);
    await assert.rejects(settle(db, [...kept, lost], true, NOW + 600), /1 listed events have no kept row; the saved point stays/);
    assert.equal(await point(db), NOW);
  });

  it('a payment\'s kind moves up to subscription.renewed whichever of its PaymentIntent and invoice arrives first, one at a time or in a page, and never down', async () => {
    const intent = (id: string): Event => ({ id: `payment-event:payment:${id}`, event_id: `payment:${id}`, occurred_at: '2026-11-25T20:00:00Z', event_kind: 'payment.confirmed',
      attributes: { customer_email: 'member@example.test', provider_object_ref: id } });
    const invoice = (id: string): Event => ({ ...intent(id), event_kind: 'subscription.renewed', attributes: { ...intent(id).attributes, subscription_id: 'sub_1' } });
    const kindOf = async (db: PGlite, id: string) => (await db.query<{ event_kind: string }>('SELECT event_kind FROM payment_events WHERE id = $1', [`payment-event:payment:${id}`])).rows.map(row => row.event_kind);
    const one = await store();
    assert.equal(await keepOne(one, intent('pi_up')), 1);
    assert.equal(await keepOne(one, invoice('pi_up')), 0);
    assert.deepEqual(await kindOf(one, 'pi_up'), ['subscription.renewed'], 'the intent first, then its invoice: moved up');
    assert.equal(await keepOne(one, intent('pi_up')), 0);
    assert.deepEqual(await kindOf(one, 'pi_up'), ['subscription.renewed'], 'never down');
    const page = await store();
    assert.deepEqual(await keepList(page, [intent('pi_a'), invoice('pi_a'), invoice('pi_b'), intent('pi_b')]), { listed: 4, kept: 2 });
    assert.deepEqual([await kindOf(page, 'pi_a'), await kindOf(page, 'pi_b')], [['subscription.renewed'], ['subscription.renewed']], 'in one page, either order');
    await keepOne(page, intent('pi_c'));
    assert.deepEqual(await keepList(page, [invoice('pi_c')]), { listed: 1, kept: 0 });
    assert.deepEqual(await kindOf(page, 'pi_c'), ['subscription.renewed'], 'a page moves a stored row up');
  });

  it('a page kept under the older checkout id settles: the stored row is the same payment', async () => {
    const db = await store();
    await keepOldShaped(db, 'cs_old2');
    const page = await checkoutList([oneTime('cs_old2', 'pi_old2')]);
    assert.deepEqual(await keepList(db, page), { listed: 1, kept: 0 });
    assert.equal((await settle(db, page, true, NOW)).moved, true);
  });
});
