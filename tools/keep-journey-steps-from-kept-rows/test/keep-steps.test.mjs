// tools/keep-journey-steps-from-kept-rows/test/keep-steps.test.mjs
// Kept rows become journey steps, in PGlite: a TidyCal booking statement and a paid payment event are read and kept once,
// a second run keeps nothing new, a sale for an offer the pursuit does not sell keeps no step, a step with only a touch id
// resolves to its touch, and a row inserted late with an old event time is still kept. Synthetic buyers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { emailKey } from '../../traffic-attribution/do-work/journey.mjs';
import { keepStepsFromRows, readSql } from '../do-work/keep-steps.mjs';

const journeySql = readFileSync(resolve(import.meta.dirname, '../../traffic-attribution/read-data/journey-steps.sql'), 'utf8');

async function pursuitDatabase() {
  const db = new PGlite();
  await db.exec(journeySql);
  await db.exec(`
    CREATE TABLE statements (key text PRIMARY KEY, source text, place text, meaning text, after jsonb, at timestamptz, recorded_at timestamptz DEFAULT now());
    CREATE TABLE payment_events (id text PRIMARY KEY, event_kind text, occurred_at timestamptz, attributes jsonb, made_at timestamptz DEFAULT now());
    CREATE TABLE offers (id text PRIMARY KEY);
    INSERT INTO offers VALUES ('offer:course');
    INSERT INTO statements (key, source, place, meaning, after, at, recorded_at) VALUES
      ('b1', 'tidycal-api-token', 'booking', 'booked', '{"email":"Ana@Example.com","starts_at":"2026-11-25T10:00:00Z"}', '2026-11-20T09:00:00Z', '2026-11-20T09:00:01Z'),
      ('b2', 'tidycal-api-token', 'booking', 'cancelled', '{"email":"ana@example.com"}', '2026-11-20T10:00:00Z', '2026-11-20T10:00:01Z'),
      ('b3', 'other-source', 'booking', 'booked', '{"email":"x@example.com"}', '2026-11-20T11:00:00Z', '2026-11-20T11:00:01Z');
    INSERT INTO payment_events (id, event_kind, occurred_at, attributes, made_at) VALUES
      ('pe1', 'payment.confirmed', '2026-11-21T08:00:00Z', '{"payment_status":"paid","offer_id":"offer:course","customer_email":"Ana@Example.com","journey_visitor":"visitor-a-1","amount_due_today_cents":4900}', '2026-11-21T08:00:01Z'),
      ('pe2', 'payment.confirmed', '2026-11-21T09:00:00Z', '{"payment_status":"paid","offer_id":"offer:elsewhere","customer_email":"ben@example.com","amount_due_today_cents":900}', '2026-11-21T09:00:01Z'),
      ('pe3', 'payment.refunded', '2026-11-21T10:00:00Z', '{"payment_status":"paid","offer_id":"offer:course","customer_email":"cy@example.com","amount_due_today_cents":900}', '2026-11-21T10:00:01Z');
    INSERT INTO journey_touches (id, destination, source) VALUES ('touch-1', 'https://site.example/offer', '{"utm_source":"instagram","utm_campaign":"reel-12"}');
    INSERT INTO journey_steps (step, touch_id, joined_by) VALUES ('click', 'touch-1', 'touch');
  `);
  return db;
}

const mappings = [
  {
    id: 'tidycal-bookings-from-statements', table: 'statements', step: 'booking',
    where: "source = 'tidycal-api-token' AND place = 'booking' AND meaning = 'booked'", cutoff_column: 'recorded_at',
    fields: { ref: "'tidycal:' || key", at: 'at', email: "after->>'email'" },
    source: { starts_at: "after->>'starts_at'" }, joined_by: 'email',
  },
  {
    id: 'stripe-sales-from-payment-events', table: 'payment_events', step: 'sale', cutoff_column: 'made_at',
    where: "event_kind = 'payment.confirmed' AND attributes->>'payment_status' = 'paid' AND attributes->>'offer_id' IN (SELECT id FROM offers)",
    fields: {
      ref: 'id::text', at: 'occurred_at', email: "attributes->>'customer_email'", visitor: "attributes->>'journey_visitor'",
      offer_id: "attributes->>'offer_id'", value_cents: "(attributes->>'amount_due_today_cents')::bigint",
    },
    joined_by: 'email', joined_by_visitor: 'client_reference_id',
  },
];

test('the statements booking and the in-scope paid sale are kept once; a second run keeps nothing; out-of-scope rows keep nothing', async () => {
  const db = await pursuitDatabase();
  const query = (sql, params) => db.query(sql, params);

  const first = await keepStepsFromRows({ query, mappings });
  assert.deepEqual(first.mappings.map(({ id, read, kept }) => ({ id, read, kept })), [
    { id: 'tidycal-bookings-from-statements', read: 1, kept: 1 },
    { id: 'stripe-sales-from-payment-events', read: 1, kept: 1 },
  ]);

  const { rows: steps } = await db.query("SELECT step, ref, visitor, email_key, offer_id, value_cents, joined_by, source FROM journey_steps WHERE step IN ('booking', 'sale') ORDER BY step");
  assert.deepEqual(steps.map(({ step, ref, visitor, offer_id, value_cents, joined_by, source }) => ({ step, ref, visitor, offer_id, value_cents, joined_by, source })), [
    { step: 'booking', ref: 'tidycal:b1', visitor: null, offer_id: null, value_cents: null, joined_by: 'email', source: { starts_at: '2026-11-25T10:00:00Z' } },
    { step: 'sale', ref: 'pe1', visitor: 'visitor-a-1', offer_id: 'offer:course', value_cents: 4900, joined_by: 'client_reference_id', source: null },
  ]);
  assert.equal(steps[0].email_key, emailKey('ana@example.com'));
  assert.equal(JSON.stringify(steps).includes('Ana@Example.com'), false);

  const second = await keepStepsFromRows({ query, mappings });
  assert.deepEqual(second.mappings.map(({ kept }) => kept), [0, 0]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_steps WHERE step IN ('booking', 'sale')")).rows[0].n, 2);
});

test('a sale for an offer the pursuit does not sell keeps no step', async () => {
  const db = await pursuitDatabase();
  const answer = await keepStepsFromRows({ query: (sql, params) => db.query(sql, params), mappings: [mappings[1]] });
  assert.equal(answer.mappings[0].read, 1);
  const { rows } = await db.query("SELECT ref FROM journey_steps WHERE step = 'sale'");
  assert.deepEqual(rows.map(row => row.ref), ['pe1']);
});

test('a row inserted late with an old event time is kept: the cutoff is the insert time, not the event time', async () => {
  const db = await pursuitDatabase();
  const query = (sql, params) => db.query(sql, params);
  await keepStepsFromRows({ query, mappings });
  // Backfilled statement: its event time (at) is older than every step already kept, but it was inserted just now.
  await db.query("INSERT INTO statements (key, source, place, meaning, after, at) VALUES ('b9', 'tidycal-api-token', 'booking', 'booked', '{\"email\":\"dee@example.com\",\"starts_at\":\"2026-11-27T10:00:00Z\"}', '2026-11-20T06:08:00Z')");
  const again = await keepStepsFromRows({ query, mappings: [mappings[0]] });
  assert.deepEqual(again.mappings.map(({ read, kept }) => ({ read, kept })), [{ read: 1, kept: 1 }]);
  const { rows } = await db.query("SELECT ref, at FROM journey_steps WHERE ref = 'tidycal:b9'");
  assert.equal(rows.length, 1);
  assert.equal(new Date(rows[0].at).getTime() > new Date('2026-11-21T00:00:00Z').getTime(), true);
});

test('a step with only a touch id resolves to that touch, and its first touch is the touch source', async () => {
  const db = await pursuitDatabase();
  const { rows } = await db.query("SELECT person FROM journey_resolved_steps WHERE step = 'click'");
  assert.deepEqual(rows, [{ person: 'touch:touch-1' }]);
  const first = await db.query("SELECT visitor, source->>'utm_source' AS utm_source FROM journey_first_touch");
  assert.deepEqual(first.rows, [{ visitor: 'touch:touch-1', utm_source: 'instagram' }]);
});

test('a mapping with no ref or no cutoff_column is refused before any row is read', async () => {
  const db = await pursuitDatabase();
  const query = (sql, params) => db.query(sql, params);
  await assert.rejects(keepStepsFromRows({ query, mappings: [{ ...mappings[0], fields: { at: 'at' } }] }), /names no ref/);
  await assert.rejects(keepStepsFromRows({ query, mappings: [{ ...mappings[0], cutoff_column: undefined }] }), /names no cutoff_column/);
});

test('the read takes only the cutoff and the step as parameters, nothing from the input', () => {
  const sql = readSql(mappings[0]);
  assert.match(sql, /\$1::timestamptz/);
  assert.match(sql, /step = \$2/);
  assert.match(sql, /\(recorded_at\) >/);
  assert.doesNotMatch(sql, /\$3/);
});

test('a row committed within the overlap before the newest kept step is read and kept once; an older one is not read', async () => {
  const db = await pursuitDatabase();
  const query = (sql, params) => db.query(sql, params);
  await keepStepsFromRows({ query, mappings: [mappings[0]] });
  // Committed late: its insert time is 5 minutes before the newest kept step, inside the 10-minute overlap.
  await db.query("INSERT INTO statements (key, source, place, meaning, after, at, recorded_at) SELECT 'b8', 'tidycal-api-token', 'booking', 'booked', '{\"email\":\"eli@example.com\"}', now(), (SELECT max(at) FROM journey_steps) - interval '5 minutes'");
  const late = await keepStepsFromRows({ query, mappings: [mappings[0]] });
  assert.deepEqual(late.mappings.map(({ read, kept }) => ({ read, kept })), [{ read: 1, kept: 1 }]);
  const again = await keepStepsFromRows({ query, mappings: [mappings[0]] });
  assert.deepEqual(again.mappings.map(({ read, kept }) => ({ read, kept })), [{ read: 1, kept: 0 }]);
  // Older than the overlap: never read again.
  await db.query("INSERT INTO statements (key, source, place, meaning, after, at, recorded_at) SELECT 'b7', 'tidycal-api-token', 'booking', 'booked', '{\"email\":\"fay@example.com\"}', now(), (SELECT max(at) FROM journey_steps) - interval '30 minutes'");
  const old = await keepStepsFromRows({ query, mappings: [mappings[0]] });
  assert.deepEqual(old.mappings.map(({ read, kept }) => ({ read, kept })), [{ read: 1, kept: 0 }]);
});

test('a ref in journey_excluded_refs is never kept again, even after its steps are deleted; the resolved view drops an excluded step', async () => {
  const db = await pursuitDatabase();
  const query = (sql, params) => db.query(sql, params);
  await keepStepsFromRows({ query, mappings });
  // The proof booking: its ref is excluded first, then its step is deleted, as the setup procedure does.
  await db.query("INSERT INTO journey_excluded_refs (ref, why) VALUES ('tidycal:b1', 'attribution proof test booking')");
  await db.query("DELETE FROM journey_steps WHERE ref = 'tidycal:b1'");
  const again = await keepStepsFromRows({ query, mappings });
  assert.deepEqual(again.mappings.map(({ read, kept }) => ({ read, kept })), [{ read: 0, kept: 0 }, { read: 0, kept: 0 }]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_steps WHERE ref = 'tidycal:b1'")).rows[0].n, 0);
  // An excluded step that is still in journey_steps (the sale kept earlier in this test) does not show in the resolved view.
  await db.query("INSERT INTO journey_excluded_refs (ref, why) VALUES ('pe1', 'attribution proof test payment')");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_steps WHERE ref = 'pe1'")).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_resolved_steps WHERE ref = 'pe1'")).rows[0].n, 0);
});

test('a source row fixed after it was kept is read again by its ref, whatever its old cutoff, and its missing email fills', async () => {
  const db = await pursuitDatabase();
  const query = (sql, params) => db.query(sql, params);
  await db.query("INSERT INTO statements (key, source, place, meaning, after, at, recorded_at) VALUES ('b6', 'tidycal-api-token', 'booking', 'booked', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')");
  await keepStepsFromRows({ query, mappings: [mappings[0]] });
  const kept = (await db.query("SELECT email_key FROM journey_steps WHERE ref = 'tidycal:b6'")).rows[0];
  assert.equal(kept.email_key, null);
  // Fixed later: the payload arrives, its recorded_at stays old.
  await db.query(`UPDATE statements SET after = '{"email":"fay@example.com","starts_at":"2026-11-30T10:00:00Z"}' WHERE key = 'b6'`);
  const byCutoff = await keepStepsFromRows({ query, mappings: [mappings[0]] });
  assert.deepEqual(byCutoff.mappings.map(({ read }) => read), [0]);
  const byRef = await keepStepsFromRows({ query, refs: ['tidycal:b6'], mappings: [mappings[0]] });
  assert.deepEqual(byRef.mappings.map(({ read, kept }) => ({ read, kept })), [{ read: 1, kept: 1 }]);
  assert.equal((await db.query("SELECT email_key FROM journey_steps WHERE ref = 'tidycal:b6'")).rows[0].email_key, emailKey('fay@example.com'));
});

