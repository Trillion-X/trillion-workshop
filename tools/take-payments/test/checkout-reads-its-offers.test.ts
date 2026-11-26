// tools/take-payments/test/checkout-reads-its-offers.test.ts
//
// tool:start-a-stripe-checkout (reads/start-a-checkout-reading-its-offers.ts) given a `database` and no `offers` reads the offers
// and suggested-amount rows itself (read-data/checkout-offer-reads.ts) and answers, and asks Stripe, exactly what it does when the same rows are handed in.
// Proved on PGlite (real Postgres) with the two tables in the column shapes a pursuit keeps them in, read under a declared use
// by a reader login that run-sql's own may-read-under-row-rules recipe makes for exactly the tables reader-rights.json declares. A made-up
// bakery's rows; a stand-in Stripe records every request. Nothing here reaches Stripe or a real database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { startAStripeCheckout } from '../reads/start-a-checkout-reading-its-offers.ts';
import { CHECKOUT_OFFER_READS, readCheckoutLists } from '../read-data/checkout-offer-reads.ts';
import { readInDatabase } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';
import { runSql, withSqlRead } from '../../run-sql-in-my-database/do-work/run-sql.mjs';

const OWNER = 'postgres://bakery_owner@127.0.0.1/postgres';
const USE = { purpose: 'publish', surface: 'site/bakery.example' };
const choice = {
  checkoutAttemptId: 'attempt-000000000001', checkoutStartedAt: '2026-01-02T03:04:05Z', offerId: 'offer:loaf-club',
  priceOptionId: 'price:loaf-club:monthly', customerSelectedAmountCents: 10000, consent: { billing: true, legal: true },
  success_url: 'https://bakery.example/ok', cancel_url: 'https://bakery.example/no', customer: { email: 'ana@example.com', firstName: 'Ana', lastName: 'Baker' },
};

// The two tables in the shapes a pursuit keeps them in (every column, with its type), and a made-up bakery's rows.
const TABLES = `
  create table offers (id text primary key, label text, summary text, access_refs jsonb, benefits jsonb, checkout_role text,
    content_refs jsonb, for_sale boolean, oto_route_path text, owned_content_refs jsonb, price_options jsonb, sort_order numeric,
    legacy_contract_refs jsonb, post_purchase_route_path text, pursuit_ids jsonb, public_offer_id text, supersedes_offer_ids jsonb,
    made_at timestamptz, changed_at timestamptz, access_ends_at timestamptz, access_days integer, access_source_note text,
    onboarding_links jsonb, link_url text, cta_line text, fits_topics jsonb, product_id text, cta_approved boolean,
    link_checked_at timestamptz, link_checked_by text, grants_access boolean);
  create table offer_amount_choices (id text primary key, label text, offer jsonb, multiple numeric, shown boolean, custom boolean,
    changed_at timestamptz);`;
const loafClub = {
  id: 'offer:loaf-club', label: 'Loaf club', summary: 'A loaf a week.', access_refs: ['access:loaf-club'], benefits: ['Fresh bread'],
  content_refs: [], for_sale: true, post_purchase_route_path: '/welcome', sort_order: 30, public_offer_id: null, supersedes_offer_ids: null,
  price_options: [{ id: 'price:loaf-club:monthly', label: 'Monthly', amount_cents: 9900, currency: 'usd', interval: 'month', payment_timing: 'recurring',
    voluntary_amount_policy: { currency: 'usd',
      price_discovery: { start_cents: 5000, sales_to_double: 1, target_win_rate: 0.05, sales: 0, reached_price: 0 },
      suggestion_rows: { list: 'list:offer-amount-choices', offer_field: 'offer', value_field: 'multiple', shown_field: 'shown', custom_field: 'custom' } } }],
};
const crumbBox = { ...loafClub, id: 'offer:crumb-box', label: 'Crumb box', sort_order: 10, access_refs: ['access:crumb-box'],
  price_options: [{ id: 'price:crumb-box:once', label: 'Once', amount_cents: 1500, currency: 'usd', payment_timing: 'one_time' }] };
const choices = [
  { id: 'choice:custom', label: 'Custom', offer: ['offer:loaf-club'], multiple: null, shown: true, custom: true },
  { id: 'choice:1x', label: '1x', offer: ['offer:loaf-club'], multiple: 1, shown: true, custom: false },
  { id: 'choice:2x', label: '2x', offer: ['offer:loaf-club'], multiple: 2, shown: true, custom: false },
  { id: 'choice:10x', label: '10x', offer: ['offer:loaf-club'], multiple: 10, shown: false, custom: false },
];

async function bakery() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role bakery_owner; create role bakery_reader; alter database postgres owner to bakery_owner;
    grant all on schema public to bakery_owner; set role bakery_owner; ${TABLES}`);
  for (const offer of [loafClub, crumbBox]) {
    await db.query(`insert into offers (id, label, summary, access_refs, benefits, content_refs, for_sale, post_purchase_route_path, price_options, sort_order,
      public_offer_id, supersedes_offer_ids, made_at, changed_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())`,
    [offer.id, offer.label, offer.summary, JSON.stringify(offer.access_refs), JSON.stringify(offer.benefits), JSON.stringify(offer.content_refs), offer.for_sale,
      offer.post_purchase_route_path, JSON.stringify(offer.price_options), offer.sort_order, offer.public_offer_id, offer.supersedes_offer_ids]);
  }
  for (const row of choices) {
    await db.query('insert into offer_amount_choices (id, label, offer, multiple, shown, custom, changed_at) values ($1, $2, $3, $4, $5, $6, now())',
      [row.id, row.label, JSON.stringify(row.offer), row.multiple, row.shown, row.custom]);
  }
  await db.exec('reset role');
  const KEY = randomBytes(32).toString('base64url');
  // A session as `role`: run-sql's statements on this one PGlite, as a pg client would send them.
  const connectAs = (role: string) => async () => {
    await db.exec(`reset role; set role ${role}`);
    return { query: async ({ text, values }: { text: string; values?: unknown[] }) => { const result = await db.query(text, values); return { fields: result.fields, rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; },
      end: async () => { await db.exec('reset role'); } };
  };
  // The reader login's grant, made by run-sql's own recipe for exactly the tables the checkout declares it reads.
  const tables = Object.values(CHECKOUT_OFFER_READS).map(read => read.table);
  await runSql({ connection: OWNER, heldValue: KEY, connect: connectAs('bakery_owner'), input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: 'bakery_reader', tables } } });
  const ticket = () => { const payload = Buffer.from(JSON.stringify({ nonce: randomBytes(16).toString('hex'), ...USE, until: Date.now() + 60_000 })).toString('hex'); return `${payload}.${createHmac('sha256', KEY).update(payload).digest('hex')}`; };
  // The checkout's read as a run makes it under the use: the reader login, one transaction that claims the use first.
  const readOffersAs = (role: string) => (input: { database: string; use?: unknown }) => readInDatabase(input as never, readCheckoutLists, {
    connection: OWNER, ticket: ticket(), read: (options: object, work: unknown) => withSqlRead({ ...options, connect: connectAs(role) }, work as never),
  } as never);
  return { db, readOffersAs };
}

/** A stand-in Stripe: Checkout Sessions get the fixture id; every request is recorded. */
function stripe() {
  const sent: { url: string; body: string }[] = [];
  return { sent, send: async (request: { url: string; body: string }) => { sent.push(request); return { id: 'cs_1', url: 'https://pay.example/cs_1' }; } };
}

// The site row's own statements for the two lists today, as the rows hand them in.
const HANDED_OFFERS = 'SELECT id, label, summary, access_refs, benefits, content_refs, for_sale, post_purchase_route_path, price_options, public_offer_id, sort_order, supersedes_offer_ids FROM offers';
const HANDED_SUGGESTIONS = 'SELECT *, multiple::float8 AS multiple FROM offer_amount_choices';

test('reading its own offers answers and asks Stripe exactly what the same rows handed in do', async () => {
  const { db, readOffersAs } = await bakery();
  const handedIn = { offers: (await db.query(HANDED_OFFERS)).rows, suggestions: (await db.query(HANDED_SUGGESTIONS)).rows };
  const one = stripe();
  const given = await startAStripeCheckout({ ...choice, ...handedIn }, { send: one.send });
  const two = stripe();
  const read = await startAStripeCheckout({ ...choice, database: 'bakery_for_who_runs_it', use: USE }, { send: two.send, readOffers: readOffersAs('bakery_reader') });
  assert.deepEqual(read, given);
  assert.deepEqual(two.sent, one.sent);
  assert.equal(given.amountDueTodayCents, '10000', 'the 2x suggested amount the buyer chose');
  assert.equal(one.sent.length, 1);
});

test('the reads are exactly two plain SELECTs of the tables and columns reader-rights.json declares for the grant, and multiple is a number', async () => {
  const { readOffersAs } = await bakery();
  const asked: string[] = [];
  const lists = await readCheckoutLists(null, async sql => { asked.push(sql); return []; });
  assert.deepEqual(lists, { offers: [], suggestions: [] });
  assert.deepEqual(asked, [
    `SELECT ${CHECKOUT_OFFER_READS.offers.columns.join(', ')} FROM public.offers`,
    'SELECT changed_at, custom, id, label, multiple::float8 AS multiple, offer, shown FROM public.offer_amount_choices',
  ]);
  const declared = JSON.parse(readFileSync(new URL('../read-data/reader-rights.json', import.meta.url), 'utf8')).reads;
  assert.deepEqual([CHECKOUT_OFFER_READS.offers, CHECKOUT_OFFER_READS.suggestions].sort((a, b) => a.table.localeCompare(b.table)), declared.sort((a: { table: string }, b: { table: string }) => a.table.localeCompare(b.table)));
  const read = await readOffersAs('bakery_reader')({ database: 'bakery_for_who_runs_it', use: USE });
  assert.equal(read.offers.length, 2);
  assert.deepEqual(read.suggestions.map(row => row.multiple).sort(), [1, 10, 2, null]);
});

test('a database whose read is refused stops the checkout with the reason, and nothing is sent', async () => {
  const { db, readOffersAs } = await bakery();
  await db.exec('create role bakery_nobody');
  const none = stripe();
  await assert.rejects(
    startAStripeCheckout({ ...choice, database: 'bakery_for_who_runs_it', use: USE }, { send: none.send, readOffers: readOffersAs('bakery_nobody') }),
    /The offers could not be read from bakery_for_who_runs_it: .*(permission denied|claim_use)/,
  );
  assert.equal(none.sent.length, 0);
});

test('a request with offers never reads, and one with neither offers nor database is refused as before', async () => {
  const one = stripe();
  let reads = 0;
  await startAStripeCheckout({ ...choice, offers: [loafClub], suggestions: choices, database: 'bakery_for_who_runs_it' }, { send: one.send, readOffers: async () => { reads += 1; return { offers: [], suggestions: [] }; } });
  assert.equal(reads, 0);
  await assert.rejects(startAStripeCheckout({ ...choice }, { send: stripe().send }), /Pass your offers in the request/);
});

test('a run as the row starts it reads the connection on 6 through run-sql, and a refused connect is told without the login', async () => {
  // The row's own process: run-a-function with the database's connection on descriptor 6 (a pipe here); no database listens there.
  const held = 'postgres://bakery_reader:held-login-word@127.0.0.1:1/bakery_for_who_runs_it';
  const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const child = spawn(process.execPath, ['--no-warnings', here('../../workflows/do-work/run-a-function.mjs'), here('../reads/start-a-checkout-reading-its-offers.ts'), 'startAStripeCheckout'],
    { stdio: ['pipe', 'pipe', 'pipe', null, null, null, 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  child.stdout!.on('data', chunk => out.push(chunk));
  (child.stdio[6] as NodeJS.WritableStream).end(held);
  (child.stdio[7] as NodeJS.WritableStream).end('made-up-ticket-word');
  child.stdin!.end(JSON.stringify({ ...choice, database: 'bakery_for_who_runs_it', use: USE }));
  const [code] = await once(child, 'close');
  const line = JSON.parse(Buffer.concat(out).toString('utf8'));
  assert.equal(code, 1);
  assert.match(line.error, /^The offers could not be read from bakery_for_who_runs_it: .*ECONNREFUSED/);
  assert.ok(!line.error.includes('held-login-word') && !line.error.includes('made-up-ticket-word'), line.error);
});

test('a database without a use is refused before any read or descriptor, and nothing reaches Stripe', async () => {
  for (const use of [undefined, null, {}, { purpose: '' }, 'publish']) {
    const none = stripe();
    let reads = 0;
    await assert.rejects(
      startAStripeCheckout({ ...choice, database: 'bakery_for_who_runs_it', ...(use === undefined ? {} : { use }) }, { send: none.send, readOffers: async () => { reads += 1; return { offers: [], suggestions: [] }; } }),
      /^Error: A checkout reads offers only under a use\./,
    );
    assert.equal(reads, 0, `no read for use ${JSON.stringify(use)}`);
    assert.equal(none.sent.length, 0);
  }
  // The row's own process: no descriptor is mounted at all, and the refusal is the same.
  const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const child = spawn(process.execPath, ['--no-warnings', here('../../workflows/do-work/run-a-function.mjs'), here('../reads/start-a-checkout-reading-its-offers.ts'), 'startAStripeCheckout'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  child.stdout!.on('data', chunk => out.push(chunk));
  child.stdin!.end(JSON.stringify({ ...choice, database: 'bakery_for_who_runs_it' }));
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.match(JSON.parse(Buffer.concat(out).toString('utf8')).error, /^A checkout reads offers only under a use\./);
});

test('the row reads the database on 6 and its use ticket on 7, and the Stripe key mounts are as they were', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map((record: { payload: unknown }) => record.payload);
  const row = rows.find((payload: { id: string }) => payload.id === 'tool:start-a-stripe-checkout');
  const mounts = row.invoke.credential_mounts;
  assert.deepEqual(mounts.slice(0, 3), [
    { secret_name_from_input: 'secret_name', share_by_listing: true, fd: 4, only_when: { input: 'secret_name', present: true } },
    { secret_name_from_input: 'account', held_suffix: '-stripe-secret-key', fd: 4, only_when: { input: 'account', present: true } },
    { fd: 4, field_id: 'secret_key', only_when: { input: 'seller_connection', present: true } },
  ]);
  assert.deepEqual(mounts[3], { secret_name_from_input: 'database', held_suffix: '-reader-connection', fd: 6, only_when: { input: 'database', present: true },
    under_use: { use_from_input: 'use', ticket_fd: 7, held_suffix: '-reader-connection', key_suffix: '-use-key' } });
  assert.deepEqual(row.input_schema.anyOf, [{ required: ['offers'] }, { required: ['database', 'use'] }]);
  assert.ok(!row.input_schema.required.includes('offers'));
});
