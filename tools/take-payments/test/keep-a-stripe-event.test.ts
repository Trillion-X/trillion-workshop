// tool:keep-a-stripe-event on a real Postgres (PGlite): a signed Stripe call is checked and its payment kept once, as a login
// holding exactly read-data/writer-rights.json; a call sent again, or a payment the catch-up kept first, adds nothing and answers
// the stored id; a call not believed, or of a kind the map does not read, opens no database; a keep without a use or a database
// is refused before anything is read; and the row mounts the webhook secret, the Stripe key and the writer login under a use. A
// real run of the function through the function runner tells a refused connection without the login. No key and no network.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { listCompletedCheckoutsAsPaymentEvents } from '../do-work/take-payments.mjs';
import { keepPaymentEvent, paymentEventsShape, type PaymentEvent, type Query } from '../do-work/payment-keys.ts';
import { keepAStripeEvent } from '../keeps/keep-a-stripe-event.ts';

const NOW = 1_790_000_000;
const SECRET = 'whsec_keep_a_stripe_event_fixture';
const USE = { purpose: 'keep-payments', surface: 'site/example.test' };
const offers = [{ kind: 'commercial-offer', id: 'offer:seat', label: 'Seat', access_refs: ['access:seat'], price_options: [{ id: 'price:seat', label: 'Seat', amount_cents: 29900, currency: 'usd', payment_timing: 'one_time' }] }];
const rights = JSON.parse(readFileSync(new URL('../read-data/writer-rights.json', import.meta.url), 'utf8')).writes as Array<{ table: string; select: string[]; insert: string[]; update?: string[] }>;
const row = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map((record: { payload: unknown }) => record.payload)
  .find((payload: { id: string }) => payload.id === 'tool:keep-a-stripe-event');

const checkout = (id: string, paymentIntent: string) => ({
  id, object: 'checkout.session', status: 'complete', created: NOW - 60, amount_total: 29900, currency: 'usd', subscription: null,
  mode: 'payment', payment_intent: paymentIntent, payment_status: 'paid',
  customer_details: { email: 'buyer@example.test' }, metadata: { offer_id: 'offer:seat', price_option_id: 'price:seat' },
});
function call(object: object, type = 'checkout.session.completed', secret = SECRET) {
  const payload = JSON.stringify({ id: `evt_${(object as { id: string }).id}_${type}`, type, created: NOW - 60, data: { object } });
  const signature = createHmac('sha256', secret).update(`${NOW}.${payload}`, 'utf8').digest('hex');
  return { payload, signature_header: `t=${NOW},v1=${signature}`, now_seconds: NOW, database: 'shop_for_who_runs_it', use: USE };
}

// The store, and a keep that runs as a login holding exactly the writer rights file's columns, as the engine's writer login does.
async function store() {
  const db = new PGlite();
  for (const statement of paymentEventsShape()) await db.exec(statement);
  await db.exec('CREATE ROLE keeper NOLOGIN');
  for (const { table, select, insert, update } of rights) {
    await db.exec(`GRANT SELECT (${select.join(', ')}) ON ${table} TO keeper`);
    await db.exec(`GRANT INSERT (${insert.join(', ')}) ON ${table} TO keeper`);
    if (update?.length) await db.exec(`GRANT UPDATE (${update.join(', ')}) ON ${table} TO keeper`);
  }
  return db;
}
function keeperOf(db: PGlite, opened: string[] = []) {
  return async (given: { database: string }, event: PaymentEvent, kinds: string[]) => {
    opened.push(given.database);
    await db.exec('SET ROLE keeper');
    try {
      const query: Query = async (sql, params) => (await db.query(sql, params)).rows as Record<string, unknown>[];
      return await keepPaymentEvent(query, event, kinds);
    } finally {
      await db.exec('RESET ROLE');
    }
  };
}
const context = (db: PGlite, opened: string[] = []) => ({ secrets: { webhookSecret: SECRET }, keep: keeperOf(db, opened) });
const count = async (db: PGlite) => Number((await db.query<{ n: number }>('SELECT count(*) n FROM payment_events')).rows[0].n);

describe('tool:keep-a-stripe-event', () => {
  it('keeps a signed checkout\'s payment once as the writer login, and a call sent again adds nothing and answers the same id', async () => {
    const db = await store();
    const first = await keepAStripeEvent(call(checkout('cs_1', 'pi_1')), context(db));
    assert.deepEqual(first, { admitted: true, event_kind: 'payment.confirmed', id: 'payment-event:payment:pi_1', kept: 1 });
    assert.deepEqual(await keepAStripeEvent(call(checkout('cs_1', 'pi_1')), context(db)), { ...first, kept: 0 });
    assert.equal(await count(db), 1);
  });

  it('a payment the catch-up kept first is not kept again, and the stored id is answered', async () => {
    const db = await store();
    const send = async () => ({ data: [checkout('cs_2', 'pi_2')], has_more: false });
    const [listed] = (await listCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0, offers }, { send })).events as PaymentEvent[];
    const owner: Query = async (sql, params) => (await db.query(sql, params)).rows as Record<string, unknown>[];
    assert.equal((await keepPaymentEvent(owner, listed)).kept, 1);
    assert.deepEqual(await keepAStripeEvent(call(checkout('cs_2', 'pi_2')), context(db)), { admitted: true, event_kind: 'payment.confirmed', id: listed.id, kept: 0 });
    assert.equal(await count(db), 1);
  });

  it('a call signed with another secret, or of a kind the map does not read, opens no database', async () => {
    const db = await store();
    const opened: string[] = [];
    const forged = await keepAStripeEvent(call(checkout('cs_3', 'pi_3'), 'checkout.session.completed', 'whsec_someone_else'), context(db, opened));
    assert.equal(forged.admitted, false);
    assert.equal(forged.kept, 0);
    assert.match(String(forged.reason), /signature/);
    const unread = await keepAStripeEvent(call({ id: 'cus_1', object: 'customer' }, 'customer.created'), context(db, opened));
    assert.deepEqual(unread, { admitted: false, reason: 'unmapped-event-type', kept: 0 });
    assert.deepEqual(opened, []);
    assert.equal(await count(db), 0);
  });

  it('a keep with no use, or no database, is refused before anything is read', async () => {
    const db = await store();
    const opened: string[] = [];
    const reads: number[] = [];
    const watched = { ...context(db, opened), readKey: (fd: number) => { reads.push(fd); return SECRET; } };
    const { use: _use, ...noUse } = call(checkout('cs_4', 'pi_4'));
    await assert.rejects(keepAStripeEvent(noUse, watched), /A payment is kept only under a use/);
    const { database: _database, ...noDatabase } = call(checkout('cs_4', 'pi_4'));
    await assert.rejects(keepAStripeEvent(noDatabase, watched), /database is needed/);
    assert.deepEqual([opened, reads], [[], []]);
  });

  it('a login missing one written column cannot keep: the rights file is exactly what a keep needs', async () => {
    const db = await store();
    await db.exec('REVOKE INSERT (currency) ON public.payment_events FROM keeper');
    await assert.rejects(keepAStripeEvent(call(checkout('cs_5', 'pi_5')), context(db)), /permission denied/);
    assert.equal(await count(db), 0);
  });

  it('the row mounts the Stripe key on 4, the webhook secret on 5 and the writer login on 6 with the use ticket on 7', () => {
    const mounts = row.invoke.key;
    assert.deepEqual(row.invoke.run, ['node', '/opt/workflows/do-work/run-a-function.mjs', '/opt/take-payments/keeps/keep-a-stripe-event.ts', 'keepAStripeEvent']);
    assert.deepEqual(mounts.filter((mount: { fd: number }) => mount.fd === 5), [
      { secret_name_from_input: 'webhook_secret_name', share_by_listing: true, fd: 5, only_when: { input: 'webhook_secret_name', present: true } },
      { fd: 5, field_id: 'webhook_secret', only_when: { input: 'seller_connection', present: true } },
    ]);
    assert.deepEqual(mounts.filter((mount: { fd: number }) => mount.fd === 6), [{ secret_name_from_input: 'database', held_suffix: '-writer-connection', fd: 6,
      only_when: { input: 'database', present: true }, under_use: { use_from_input: 'use', ticket_fd: 7, held_suffix: '-writer-connection', key_suffix: '-use-key' } }]);
    assert.deepEqual(row.input_schema.required, ['payload', 'signature_header', 'database', 'use']);
  });

  it('a real run through the function runner tells a refused connection without the login', () => {
    const dir = tempFolder(join(tmpdir(), 'keep-a-stripe-event-'));
    const login = 'postgres://keeper:not-a-real-password-77@127.0.0.1:9/shop_for_who_runs_it';
    writeFileSync(join(dir, 'connection'), login);
    writeFileSync(join(dir, 'ticket'), 'a-made-up-ticket');
    writeFileSync(join(dir, 'secret'), SECRET);
    const runner = new URL('../../workflows/do-work/run-a-function.mjs', import.meta.url).pathname;
    const module = new URL('../keeps/keep-a-stripe-event.ts', import.meta.url).pathname;
    const given = call(checkout('cs_6', 'pi_6'));
    const script = `exec 5<"${join(dir, 'secret')}" 6<"${join(dir, 'connection')}" 7<"${join(dir, 'ticket')}"; exec "${process.execPath}" "${runner}" "${module}" keepAStripeEvent`;
    const ran = spawnSync('/bin/sh', ['-c', script], { input: JSON.stringify(given), encoding: 'utf8' });
    const answer = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}');
    assert.notEqual(ran.status, 0);
    assert.match(String(answer.error), /ECONNREFUSED|connect/);
    assert.ok(!ran.stdout.includes('not-a-real-password-77') && !ran.stderr.includes('not-a-real-password-77'), 'the login is never told');
  });
});
