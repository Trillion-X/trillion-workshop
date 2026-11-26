// One real payment is one kept row on a real Postgres (PGlite): the store's keys refuse a second row for a payment kept
// by another path or under its older checkout id, so nothing downstream of a new row runs twice; and rows kept under the
// older checkout ids move to their PaymentIntent ids with every reference, or nothing moves. No key and no network: signed
// payloads and fake Stripe replies.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { checkAStripeEvent, listCompletedCheckoutsAsPaymentEvents } from '../do-work/take-payments.mjs';
import { countsSql, keepPaymentEvent, keepPaymentEventSql, paymentEventsShape, paymentKeyMoves, paymentKindsOf, planPaymentKeyMoves, rekeySql, type Reference } from '../do-work/payment-keys.ts';

const NOW = 1_790_000_000;
const SECRET = 'whsec_payment_keys_fixture';
const offers = [{ kind: 'commercial-offer', id: 'offer:seat', label: 'Seat', access_refs: ['access:seat'], price_options: [{ id: 'price:seat', label: 'Seat', amount_cents: 29900, currency: 'usd', payment_timing: 'one_time' }] }];

type Event = { id: string; event_id: string; event_kind: string; occurred_at: string; attributes: Record<string, unknown> };
type Sent = { method: string; url: string };

const oneTime = (id: string, paymentIntent: string, amount = 29900) => ({
  id, object: 'checkout.session', status: 'complete', created: NOW - 60, amount_total: amount, currency: 'usd', subscription: null,
  mode: 'payment', payment_intent: paymentIntent, payment_status: amount > 0 ? 'paid' : 'no_payment_required',
  customer_details: { email: 'buyer@example.test' }, metadata: { offer_id: 'offer:seat', price_option_id: 'price:seat' },
});
const subscription = (id: string, invoice: string) => ({
  ...oneTime(id, '', 9900), mode: 'subscription', payment_intent: null, invoice, subscription: `sub_${id}`,
});

async function webhook(session: object): Promise<Event> {
  const payload = JSON.stringify({ id: `evt_${(session as { id: string }).id}`, type: 'checkout.session.completed', created: NOW - 60, data: { object: session } });
  const signature = createHmac('sha256', SECRET).update(`${NOW}.${payload}`, 'utf8').digest('hex');
  const checked = await checkAStripeEvent({ payload, signature_header: `t=${NOW},v1=${signature}`, now_seconds: NOW }, { secrets: { webhookSecret: SECRET }, send: invoicePayments });
  assert.equal(checked.admitted, true);
  return checked.payment_event as Event;
}

// Stripe's answer to a paid invoice's payments: one paid payment, whose PaymentIntent is the invoice id's pi_ twin.
async function invoicePayments(request: Sent) {
  const invoice = new URL(request.url).searchParams.get('invoice') ?? '';
  return { data: [{ status: 'paid', payment: { payment_intent: invoice.replace(/^in_/, 'pi_') } }], has_more: false };
}

async function checkoutList(sessions: object[]): Promise<Event[]> {
  const send = async (request: Sent) => (request.url.includes('/invoice_payments') ? invoicePayments(request) : { data: sessions, has_more: false });
  const listed = await listCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0, offers }, { send });
  return listed.events as Event[];
}

async function store() {
  const db = new PGlite();
  for (const statement of paymentEventsShape()) await db.exec(statement);
  await db.exec(`CREATE TABLE welcome_sent (payment_event_id text NOT NULL, step_day integer NOT NULL, PRIMARY KEY (payment_event_id, step_day))`);
  return db;
}

// A keep the way the tool's keep statement writes: one statement that adds the row only when the store holds no row of the same
// payment, keeps nothing on a clash of its own id, and raises on any other; only a new row starts what follows it (here, the
// welcome email's first step).
async function keep(db: PGlite, event: Event): Promise<number> {
  const { sql, params } = keepPaymentEventSql(event);
  const { rows: [answer] } = await db.query<{ id: string; kept: number }>(sql, params);
  if (answer.kept === 1) await db.query('INSERT INTO welcome_sent (payment_event_id, step_day) VALUES ($1, 0)', [answer.id]);
  return answer.kept;
}

const count = async (db: PGlite, sql: string) => Number((await db.query<{ n: number }>(sql)).rows[0].n);

// A row as it was kept before payment rows were named by their PaymentIntent.
async function keepOldShaped(db: PGlite, checkout: string, kind = 'payment.confirmed') {
  await db.query(`INSERT INTO payment_events (id, event_id, occurred_at, event_kind, offer_id, provider_object_ref, completion_ref, provider_event_id, attributes)
    VALUES ($1, $2, now(), $3, 'offer:seat', $4, $4, $2, $5)`,
  [`payment-event:checkout:${checkout}`, `checkout:${checkout}`, kind, checkout, JSON.stringify({ provider_object_ref: checkout, completion_ref: checkout, provider_event_id: `checkout:${checkout}` })]);
}

describe('the payment_events keys', () => {
  it('are drawn over the kinds a payment\'s own events are kept as, and the shape runs again unchanged', async () => {
    assert.deepEqual(paymentKindsOf(), ['payment.confirmed', 'subscription.renewed']);
    const db = await store();
    for (const statement of paymentEventsShape()) await db.exec(statement);
    const names = (await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'payment_events' ORDER BY 1`)).rows.map(r => r.indexname);
    assert.deepEqual(names, ['payment_events_email', 'payment_events_event_id_key', 'payment_events_offer', 'payment_events_one_row_per_checkout', 'payment_events_one_row_per_payment', 'payment_events_pkey']);
  });

  it('a checkout kept by the webhook, then read again by the checkout list: 0 new rows, and no second welcome', async () => {
    const db = await store();
    const session = oneTime('cs_a', 'pi_a');
    assert.equal(await keep(db, await webhook(session)), 1);
    for (const event of await checkoutList([session])) assert.equal(await keep(db, event), 0);
    assert.equal(await count(db, 'SELECT count(*) n FROM payment_events'), 1);
    assert.equal(await count(db, 'SELECT count(*) n FROM welcome_sent'), 1);
  });

  it('the reverse order gives the same: the checkout list first, then the webhook', async () => {
    const db = await store();
    const session = subscription('cs_b', 'in_b');
    for (const event of await checkoutList([session])) assert.equal(await keep(db, event), 1);
    assert.equal(await keep(db, await webhook(session)), 0);
    assert.deepEqual((await db.query('SELECT id, provider_object_ref, completion_ref FROM payment_events')).rows,
      [{ id: 'payment-event:payment:pi_b', provider_object_ref: 'pi_b', completion_ref: 'cs_b' }]);
    assert.equal(await count(db, 'SELECT count(*) n FROM welcome_sent'), 1);
  });

  it('a payment kept under its older checkout id is refused a second row under its PaymentIntent id', async () => {
    const db = await store();
    await keepOldShaped(db, 'cs_old');
    const replay = await webhook(oneTime('cs_old', 'pi_old'));
    assert.equal(replay.id, 'payment-event:payment:pi_old');
    assert.equal(await keep(db, replay), 0);
    for (const event of await checkoutList([oneTime('cs_old', 'pi_old')])) assert.equal(await keep(db, event), 0);
    assert.equal(await count(db, 'SELECT count(*) n FROM welcome_sent'), 0);
    await assert.rejects(db.query(`INSERT INTO payment_events (id, event_id, occurred_at, event_kind, provider_object_ref, completion_ref, attributes)
      VALUES ('payment-event:payment:pi_old', 'payment:pi_old', now(), 'payment.confirmed', 'pi_old', 'cs_old', '{}')`), /payment_events_one_row_per_checkout/);
  });

  it('the keep answers the id the store holds for the payment, and a clash on a key that is not the payment\'s still raises', async () => {
    const db = await store();
    await keepOldShaped(db, 'cs_old');
    const replay = await webhook(oneTime('cs_old', 'pi_old'));
    const { sql, params } = keepPaymentEventSql(replay);
    assert.deepEqual((await db.query(sql, params)).rows, [{ id: 'payment-event:checkout:cs_old', kept: 0 }], 'the stored id, not the event\'s');
    // Another payment whose event id is one already kept: not the same payment, so it is not swallowed as kept.
    const other = await webhook(oneTime('cs_other', 'pi_other'));
    const clash = keepPaymentEventSql({ ...other, event_id: 'checkout:cs_old' });
    await assert.rejects(db.query(clash.sql, clash.params), /payment_events_event_id_key/);
    assert.equal(await count(db, `SELECT count(*) n FROM payment_events WHERE id = '${other.id}'`), 0);
  });

  it('a keep that answers no id (a keep of the same id at the same moment) reads the stored row again; with none there the step fails', async () => {
    const db = await store();
    const event = await webhook(oneTime('cs_race', 'pi_race'));
    const raced = { ...event };
    await keep(db, raced);
    // The answer a keep gives when it waited on the same id kept at that moment and could not see it yet.
    const unseen = (sql: string, params: unknown[]) => (sql.startsWith('WITH moved AS') ? Promise.resolve([{ id: null, kept: 0 }]) : db.query(sql, params).then(r => r.rows as Record<string, unknown>[]));
    assert.deepEqual(await keepPaymentEvent(unseen, event), { id: 'payment-event:payment:pi_race', kept: 0 });
    const empty = await store();
    const nothing = (sql: string, params: unknown[]) => (sql.startsWith('WITH moved AS') ? Promise.resolve([{ id: null, kept: 0 }]) : empty.query(sql, params).then(r => r.rows as Record<string, unknown>[]));
    await assert.rejects(keepPaymentEvent(nothing, event), /was neither kept nor found kept/);
    const real = (sql: string, params: unknown[]) => db.query(sql, params).then(r => r.rows as Record<string, unknown>[]);
    assert.deepEqual(await keepPaymentEvent(real, await webhook(oneTime('cs_next', 'pi_next'))), { id: 'payment-event:payment:pi_next', kept: 1 });
  });

  it('a real new payment is still kept once, and a refund of it is its own row', async () => {
    const db = await store();
    await keepOldShaped(db, 'cs_old');
    assert.equal(await keep(db, await webhook(oneTime('cs_new', 'pi_new'))), 1);
    assert.equal(await keep(db, await webhook(oneTime('cs_new', 'pi_new'))), 0);
    const refund = { id: 'payment-event:evt_refund', event_id: 'evt_refund', event_kind: 'payment.refunded', occurred_at: new Date().toISOString(), attributes: { provider_object_ref: 'ch_new' } };
    assert.equal(await keep(db, refund), 1);
    assert.equal(await count(db, 'SELECT count(*) n FROM payment_events'), 3);
    assert.equal(await count(db, `SELECT count(*) n FROM welcome_sent WHERE payment_event_id = 'payment-event:payment:pi_new'`), 1);
  });
});

const references: Reference[] = [
  { table: 'welcome_sent', column: 'payment_event_id', holds: 'id' },
  { table: 'rewards', column: 'payment_event_id', holds: 'id' },
  { table: 'payment_events', column: 'attributes', holds: 'event_id', json_key: 'duplicate_of' },
];

// A store holding rows of both shapes: a one-time sale and a subscription kept under their checkout ids, a free checkout,
// a sale already named by its PaymentIntent, a duplicate marker naming the one-time sale's event id, and rows that refer
// to the sales by id.
async function storeOfBothShapes() {
  const db = await store();
  await db.exec(`CREATE TABLE rewards (friend text PRIMARY KEY, payment_event_id text NOT NULL)`);
  await db.exec(`CREATE TABLE notes (id text PRIMARY KEY, evidence jsonb)`);
  await keepOldShaped(db, 'cs_one');
  await keepOldShaped(db, 'cs_sub');
  await keepOldShaped(db, 'cs_free');
  await keep(db, await webhook(oneTime('cs_new', 'pi_new')));
  await db.query(`INSERT INTO payment_events (id, event_id, occurred_at, event_kind, provider_object_ref, attributes)
    VALUES ('payment-event:evt_dup', 'evt_dup', now(), 'payment.duplicate', 'pi_one', '{"duplicate_of": "checkout:cs_one"}')`);
  await db.exec(`INSERT INTO welcome_sent VALUES ('payment-event:checkout:cs_one', 0), ('payment-event:checkout:cs_one', 1), ('payment-event:checkout:cs_sub', 0)`);
  await db.exec(`INSERT INTO rewards VALUES ('friend-1', 'payment-event:checkout:cs_sub')`);
  await db.exec(`INSERT INTO notes VALUES ('n1', '{"seen": ["payment-event:checkout:cs_one"]}')`);
  const kept = (await db.query<{ id: string; event_id: string; event_kind: string; completion_ref: string; provider_object_ref: string }>(
    'SELECT id, event_id, event_kind, completion_ref, provider_object_ref FROM payment_events')).rows;
  const listed = await checkoutList([oneTime('cs_one', 'pi_one'), subscription('cs_sub', 'in_sub'), oneTime('cs_free', '', 0), oneTime('cs_new', 'pi_new')]);
  return { db, kept, listed };
}

const snapshot = async (db: PGlite) => ({
  payments: (await db.query('SELECT id, event_id, provider_object_ref, attributes FROM payment_events ORDER BY id')).rows,
  welcome: (await db.query('SELECT * FROM welcome_sent ORDER BY 1, 2')).rows,
  rewards: (await db.query('SELECT * FROM rewards ORDER BY 1')).rows,
});

describe('moving rows kept under their checkout ids to their PaymentIntent ids', () => {
  it('moves both sales and every reference, leaves the free checkout, and a replay then keeps nothing', async () => {
    const { db, kept, listed } = await storeOfBothShapes();
    const plan = planPaymentKeyMoves({ kept, listed, references, history: [{ table: 'notes', column: 'evidence' }] });
    assert.deepEqual(plan.moves.map(m => [m.from, m.to]).sort(), [
      ['payment-event:checkout:cs_one', 'payment-event:payment:pi_one'],
      ['payment-event:checkout:cs_sub', 'payment-event:payment:pi_sub'],
    ]);
    assert.deepEqual(plan.left, [{ id: 'payment-event:checkout:cs_free', why: 'its checkout took no payment, so it stays named by its checkout' }]);

    await db.exec(plan.rekey_sql);
    const moved = (await db.query<{ moved: Record<string, number> }>(plan.counts_sql)).rows[0].moved;
    assert.deepEqual(moved, { payment_events: 2, 'welcome_sent.payment_event_id': 3, 'rewards.payment_event_id': 1, 'payment_events.attributes.duplicate_of': 1 });
    const after = await snapshot(db);
    assert.deepEqual(after.payments.map(r => r.id), ['payment-event:checkout:cs_free', 'payment-event:evt_dup', 'payment-event:payment:pi_new', 'payment-event:payment:pi_one', 'payment-event:payment:pi_sub']);
    const one = after.payments.find(r => r.id === 'payment-event:payment:pi_one') as { event_id: string; provider_object_ref: string; attributes: Record<string, string> };
    assert.equal(one.event_id, 'payment:pi_one');
    assert.equal(one.provider_object_ref, 'pi_one');
    assert.equal(one.attributes.provider_object_ref, 'pi_one');
    assert.equal(one.attributes.provider_event_id, 'checkout:cs_one');

    for (const session of [oneTime('cs_one', 'pi_one'), subscription('cs_sub', 'in_sub')]) {
      assert.equal(await keep(db, await webhook(session)), 0);
      for (const event of await checkoutList([session])) assert.equal(await keep(db, event), 0);
    }
    assert.equal(await count(db, 'SELECT count(*) n FROM welcome_sent'), 4);
  });

  it('refuses, changing nothing, when a sale is already kept under its new id', async () => {
    const { db, kept, listed } = await storeOfBothShapes();
    const plan = planPaymentKeyMoves({ kept, listed, references, history: [{ table: 'notes', column: 'evidence' }] });
    await db.exec(`INSERT INTO payment_events (id, event_id, occurred_at, event_kind, attributes) VALUES ('payment-event:payment:pi_one', 'payment:pi_one', now(), 'payment.confirmed', '{}')`);
    const before = await snapshot(db);
    await assert.rejects(db.exec(plan.rekey_sql), /already kept under its new id or event id: payment-event:payment:pi_one/);
    assert.deepEqual(await snapshot(db), before);
  });

  it('refuses, changing nothing, when a moved reference collides with one already there', async () => {
    const { db, kept, listed } = await storeOfBothShapes();
    await db.exec(`INSERT INTO welcome_sent VALUES ('payment-event:payment:pi_one', 0)`);
    const plan = planPaymentKeyMoves({ kept, listed, references, history: [{ table: 'notes', column: 'evidence' }] });
    const before = await snapshot(db);
    await assert.rejects(db.exec(plan.rekey_sql), /welcome_sent_pkey/);
    assert.deepEqual(await snapshot(db), before);
  });

  it('refuses, changing nothing, when a column not named holds an old id, and moves once it is named as history', async () => {
    const { db, kept, listed } = await storeOfBothShapes();
    const unnamed = planPaymentKeyMoves({ kept, listed, references, history: [] });
    const before = await snapshot(db);
    await assert.rejects(db.exec(unnamed.rekey_sql), /would still hold an old payment id, pointing nowhere: notes\.evidence \(1 rows\)/);
    assert.deepEqual(await snapshot(db), before);
    const withoutRewards = planPaymentKeyMoves({ kept, listed, references: references.filter(r => r.table !== 'rewards'), history: [{ table: 'notes', column: 'evidence' }] });
    await assert.rejects(db.exec(withoutRewards.rekey_sql), /rewards\.payment_event_id \(1 rows\)/);
    assert.deepEqual(await snapshot(db), before);
  });

  it('refuses a plan where two kept rows are one payment, and names that are not plain', () => {
    const kept = [
      { id: 'payment-event:checkout:cs_x', event_id: 'checkout:cs_x', event_kind: 'payment.confirmed', completion_ref: 'cs_x' },
      { id: 'payment-event:other:cs_x', event_id: 'other:cs_x', event_kind: 'payment.confirmed', completion_ref: 'cs_x' },
    ];
    const listed = [{ id: 'payment-event:payment:pi_x', event_id: 'payment:pi_x', event_kind: 'payment.confirmed', attributes: { completion_ref: 'cs_x', provider_object_ref: 'pi_x' } }];
    assert.throws(() => paymentKeyMoves({ kept, listed }), /are one payment \(payment-event:payment:pi_x\)/);
    assert.throws(() => rekeySql({ moves: [], references: [{ table: 'Bad Name', column: 'x', holds: 'id' }] }), /not a plain lower-case name/);
    assert.match(countsSql({ moves: [], references: [] }), /ARRAY\[\]::text\[\]/);
  });
});
