// tools/keep-journey-steps-from-kept-rows/test/keep-steps.test.mjs
// Kept rows become journey steps, in PGlite: a TidyCal booking statement and a paid payment event are read and kept once,
// a second run keeps nothing new, a sale for an offer the pursuit does not sell keeps no step, a step with only a touch id
// resolves to its touch, and a row inserted late with an old event time is still kept. Synthetic buyers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { emailKey, keepStep, leadStep } from '../../traffic-attribution/do-work/journey.mjs';
import { keepStepsFromRows, readSql, runKeepSteps } from '../do-work/keep-steps.mjs';
import settings from '../read-data/journey-kept-rows.json' with { type: 'json' };

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
    joined_by: 'email', joined_by_visitor: 'journey_visitor',
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
    { step: 'sale', ref: 'pe1', visitor: 'visitor-a-1', offer_id: 'offer:course', value_cents: 4900, joined_by: 'journey_visitor', source: null },
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

// A client that runs the same SQL on the PGlite database the test holds: plain text runs as one script, a statement with a name
// runs as a prepared statement.
const connectTo = db => async () => ({
  query: (statement, values) => (typeof statement === 'string' ? db.exec(statement) : db.query(statement.text, statement.values ?? values)),
  end: async () => {},
});

// A pursuit database as it was before the kit's later objects: the first tables, with rows, and none of the views or the version row.
async function olderPursuitDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE journey_touches (id text PRIMARY KEY, destination text NOT NULL, source jsonb NOT NULL, post_id text, offer_id text, made_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE journey_steps (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), visitor text, touch_id text, step text NOT NULL, source jsonb, ref text, joined_by text, email_key text, offer_id text, value_cents bigint);
    CREATE UNIQUE INDEX journey_steps_step_ref ON journey_steps (step, ref) WHERE ref IS NOT NULL;
    CREATE TABLE statements (key text PRIMARY KEY, source text, place text, meaning text, after jsonb, at timestamptz, recorded_at timestamptz DEFAULT now());
    CREATE TABLE payment_events (id text PRIMARY KEY, event_kind text, occurred_at timestamptz, attributes jsonb, made_at timestamptz DEFAULT now());
    CREATE TABLE offers (id text PRIMARY KEY);
    INSERT INTO offers VALUES ('offer:course');
    INSERT INTO journey_touches (id, destination, source) VALUES ('touch-live', 'https://site.example/offer', '{"utm_source":"instagram"}');
    INSERT INTO journey_steps (step, ref, touch_id, joined_by, at) VALUES ('click', NULL, 'touch-live', 'touch', '2026-11-21T09:00:00Z');
    INSERT INTO journey_steps (step, ref, visitor, email_key, joined_by, at) VALUES ('booking', 'tidycal:live-1', 'visitor-live-1', NULL, 'email', '2026-11-21T09:30:00Z');
    INSERT INTO statements (key, source, place, meaning, after, at, recorded_at) VALUES ('live-1', 'tidycal-api-token', 'booking', 'booked', '{"email":"live@example.com"}', '2026-11-21T09:29:00Z', '2026-11-21T09:29:01Z');
  `);
  return db;
}

test('the kit schema applied twice to a database with rows changes no row and drops nothing', async () => {
  const db = await pursuitDatabase();
  const before = JSON.stringify((await db.query('SELECT * FROM journey_steps ORDER BY id')).rows);
  await db.exec(journeySql);
  await db.exec(journeySql);
  assert.equal(JSON.stringify((await db.query('SELECT * FROM journey_steps ORDER BY id')).rows), before);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM journey_touches')).rows[0].n, 1);
});

test('an older database gets the kit objects it lacks through the keep run, keeps its rows, and a second run applies nothing', async () => {
  const db = await olderPursuitDatabase();
  const before = (await db.query('SELECT id, at, visitor, touch_id, step, source, ref, joined_by, email_key, offer_id, value_cents FROM journey_steps WHERE id = 1')).rows;
  const first = await runKeepSteps({ input: {}, connection: 'held', connect: connectTo(db) });
  assert.equal(first.schema, 'applied');
  assert.deepEqual((await db.query('SELECT id, at, visitor, touch_id, step, source, ref, joined_by, email_key, offer_id, value_cents FROM journey_steps WHERE id = 1')).rows, before);
  // The booking row keeps its ref, visitor and time; the statement's email fills the email_key it lacked.
  const booking = (await db.query("SELECT visitor, ref, email_key FROM journey_steps WHERE ref = 'tidycal:live-1'")).rows[0];
  assert.deepEqual(booking, { visitor: 'visitor-live-1', ref: 'tidycal:live-1', email_key: emailKey('live@example.com') });
  assert.equal((await db.query("SELECT to_regclass('journey_excluded_refs') IS NOT NULL AS present")).rows[0].present, true);
  assert.equal((await db.query("SELECT to_regclass('visit_steps_by_source') IS NOT NULL AS present")).rows[0].present, true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM journey_kit_schema')).rows[0].n, 1);
  const second = await runKeepSteps({ input: {}, connection: 'held', connect: connectTo(db) });
  assert.equal(second.schema, 'current');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM journey_kit_schema')).rows[0].n, 1);
});

test('check mode names what the kit declares that the database lacks, and writes nothing', async () => {
  const db = await olderPursuitDatabase();
  const report = await runKeepSteps({ input: { mode: 'check' }, connection: 'held', connect: connectTo(db) });
  assert.equal(report.mode, 'check');
  assert.equal(report.applied, false);
  assert.ok(report.missing.includes('journey_excluded_refs'));
  assert.ok(report.missing.includes('visit_steps_by_source'));
  assert.equal(report.missing.includes('journey_steps'), false);
  assert.equal((await db.query("SELECT to_regclass('journey_excluded_refs') IS NOT NULL AS present")).rows[0].present, false);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM journey_steps')).rows[0].n, 2);
});

test('a mode other than keep or check is refused before the database is reached', async () => {
  await assert.rejects(runKeepSteps({ input: { mode: 'drop' }, connection: 'held', connect: () => { throw new Error('reached'); } }), /mode must be "keep" or "check"/);
});

test('a mapping whose source table this database lacks is skipped and reported, and the run still keeps from the others', async () => {
  // A pursuit with the kit's tables and no source tables at all: both mappings are skipped, and the run succeeds.
  const bare = new PGlite();
  await bare.exec(journeySql);
  const none = await keepStepsFromRows({ query: (sql, params) => bare.query(sql, params), mappings });
  assert.deepEqual(none.mappings, [
    { id: 'tidycal-bookings-from-statements', step: 'booking', skipped: 'no statements here' },
    { id: 'stripe-sales-from-payment-events', step: 'sale', skipped: 'no payment_events here' },
  ]);
  // A pursuit with statements and no payment events: bookings are kept, sales are skipped.
  const statementsOnly = await pursuitDatabase();
  await statementsOnly.exec('DROP TABLE payment_events');
  const some = await keepStepsFromRows({ query: (sql, params) => statementsOnly.query(sql, params), mappings });
  assert.deepEqual(some.mappings.map(item => item.id), ['tidycal-bookings-from-statements', 'stripe-sales-from-payment-events']);
  assert.deepEqual(some.mappings[1], { id: 'stripe-sales-from-payment-events', step: 'sale', skipped: 'no payment_events here' });
  assert.equal(some.mappings[0].kept, 1);
});

test('a mapping whose table exists but whose read fails is still an error', async () => {
  const db = await pursuitDatabase();
  await db.exec('ALTER TABLE statements DROP COLUMN meaning');
  await assert.rejects(keepStepsFromRows({ query: (sql, params) => db.query(sql, params), mappings: [mappings[0]] }), /meaning/);
});

// A pursuit whose payment_events has the other client's columns (event_id, customer_email, amount_cents, no id), with its offers.
async function otherShapeDatabase() {
  const db = new PGlite();
  await db.exec(journeySql);
  await db.exec(`
    CREATE TABLE payment_events (event_id text PRIMARY KEY, event_kind text, occurred_at timestamptz, offer_id text, customer_email text,
      amount_cents bigint, payment_status text, attributes jsonb, made_at timestamptz DEFAULT now());
    CREATE TABLE offers (offer_id text PRIMARY KEY);
    INSERT INTO offers VALUES ('offer:course');
    INSERT INTO payment_events (event_id, event_kind, occurred_at, offer_id, customer_email, amount_cents, payment_status, attributes, made_at) VALUES
      ('evt-1', 'payment.confirmed', '2026-11-21T08:00:00Z', 'offer:course', 'Dee@Example.com', 2900, 'paid', '{"journey_visitor":"visitor-d-1"}', '2026-11-21T08:00:01Z'),
      ('evt-2', 'payment.refunded', '2026-11-21T09:00:00Z', 'offer:course', 'eli@example.com', 2900, 'paid', '{}', '2026-11-21T09:00:01Z'),
      ('evt-3', 'payment.confirmed', '2026-11-21T10:00:00Z', 'offer:elsewhere', 'fay@example.com', 900, 'paid', '{}', '2026-11-21T10:00:01Z');
  `);
  return db;
}

test('each shape of payment_events is read through its own mapping: the first shape and the other shape keep their sales', async () => {
  const first = await pursuitDatabase();
  const firstAnswer = await keepStepsFromRows({ query: (sql, params) => first.query(sql, params), mappings: settings.mappings });
  assert.deepEqual(firstAnswer.mappings.filter(item => item.step === 'sale'), [{ id: 'stripe-sales-from-payment-events', step: 'sale', read: 1, kept: 1 }]);
  const { rows: firstSales } = await first.query("SELECT visitor, joined_by FROM journey_steps WHERE step = 'sale'");
  assert.deepEqual(firstSales, [{ visitor: 'visitor-a-1', joined_by: 'journey_visitor' }]);

  const other = await otherShapeDatabase();
  const otherAnswer = await keepStepsFromRows({ query: (sql, params) => other.query(sql, params), mappings: settings.mappings });
  assert.deepEqual(otherAnswer.mappings, [
    { id: 'tidycal-bookings-from-statements', step: 'booking', skipped: 'no statements here' },
    { id: 'stripe-sales-from-payment-events-by-columns', step: 'sale', read: 1, kept: 1 },
    { id: 'site-form-leads-from-statements', step: 'lead', skipped: 'no statements here' },
  ]);
  const { rows } = await other.query("SELECT ref, visitor, email_key, offer_id, value_cents, joined_by FROM journey_steps WHERE step = 'sale'");
  assert.deepEqual(rows, [{ ref: 'evt-1', visitor: 'visitor-d-1', email_key: emailKey('dee@example.com'), offer_id: 'offer:course', value_cents: 2900, joined_by: 'journey_visitor' }]);
  assert.equal(JSON.stringify(rows).includes('Dee@Example.com'), false);
});

test('replaying a saved sale in either format keeps its journey visitor and writes no duplicate', async () => {
  for (const [makeDatabase, ref, visitor] of [[pursuitDatabase, 'pe1', 'visitor-a-1'], [otherShapeDatabase, 'evt-1', 'visitor-d-1']]) {
    const db = await makeDatabase();
    const query = (sql, params) => db.query(sql, params);
    try {
      await query("UPDATE payment_events SET attributes = attributes || jsonb_build_object('client_reference_id', 'visitor-account-1')");
      const first = await keepStepsFromRows({ query, refs: [ref] });
      assert.deepEqual(first.mappings.filter(item => item.step === 'sale').map(({ read, kept }) => ({ read, kept })), [{ read: 1, kept: 1 }]);
      const readSale = () => query("SELECT id, at, ref, visitor, joined_by, email_key, offer_id, value_cents FROM journey_steps WHERE step = 'sale'");
      const { rows: before } = await readSale();
      assert.equal(before.length, 1);
      assert.equal(before[0].visitor, visitor);
      assert.equal(before[0].joined_by, 'journey_visitor');
      for (let replay = 0; replay < 2; replay += 1) {
        const again = await keepStepsFromRows({ query, refs: [ref] });
        assert.deepEqual(again.mappings.filter(item => item.step === 'sale').map(({ read, kept }) => ({ read, kept })), [{ read: 1, kept: 0 }]);
        assert.deepEqual((await readSale()).rows, before);
      }
    } finally {
      await db.close();
    }
  }
});

test('a table that fits none of its shapes is reported with its columns, and the run still succeeds', async () => {
  const db = new PGlite();
  await db.exec(journeySql);
  await db.exec(`
    CREATE TABLE payment_events (id text PRIMARY KEY, event_kind text);
    CREATE TABLE offers (id text PRIMARY KEY);
    INSERT INTO payment_events VALUES ('x1', 'payment.confirmed');
  `);
  const answer = await keepStepsFromRows({ query: (sql, params) => db.query(sql, params), mappings: settings.mappings });
  assert.deepEqual(answer.mappings.filter(item => item.step === 'sale'), [
    { table: 'payment_events', step: 'sale', skipped: 'no mapping fits payment_events', columns: ['event_kind', 'id'] },
  ]);
});

test('a shape whose other table lacks its column or is missing is not picked; a table that fits a shape but whose read fails is still an error', async () => {
  // The other client's payment_events, but its offers keyed by id: the shape names offers.offer_id, so no shape fits.
  const keyedByID = await otherShapeDatabase();
  await keyedByID.exec('DROP TABLE offers; CREATE TABLE offers (id text PRIMARY KEY);');
  const mismatch = await keepStepsFromRows({ query: (sql, params) => keyedByID.query(sql, params), mappings: settings.mappings });
  assert.deepEqual(mismatch.mappings.filter(item => item.step === 'sale'), [
    { table: 'payment_events', step: 'sale', skipped: 'no mapping fits payment_events', columns: ['amount_cents', 'attributes', 'customer_email', 'event_id', 'event_kind', 'made_at', 'occurred_at', 'offer_id', 'payment_status'] },
  ]);
  // The same table with no offers table at all: the shape is not picked either.
  const missing = await otherShapeDatabase();
  await missing.exec('DROP TABLE offers');
  const absent = await keepStepsFromRows({ query: (sql, params) => missing.query(sql, params), mappings: settings.mappings });
  assert.equal(absent.mappings.filter(item => item.step === 'sale')[0].skipped, 'no mapping fits payment_events');
  // A shape that fits, whose payment_status is not text: the filter's read fails, and that stays an error.
  const broken = await otherShapeDatabase();
  await broken.exec("ALTER TABLE payment_events ALTER COLUMN payment_status TYPE jsonb USING to_jsonb(payment_status)");
  await assert.rejects(keepStepsFromRows({ query: (sql, params) => broken.query(sql, params), mappings: settings.mappings }), /json/);
});

test('a proof step is kept and readable by ref, counted by no view, and purged after 24 hours; a check keeps nothing; a real step is untouched', async () => {
  const db = await pursuitDatabase();
  const query = (sql, params) => db.query(sql, params);
  const connection = connectTo(db);
  // A proof's lead and the tracked link it was sent on: kept, marked is_proof.
  await db.query("INSERT INTO journey_touches (id, destination, source) VALUES ('proof-touch', 'https://site.example/proof', '{\"utm_content\":\"proof\",\"utm_source\":\"proof\"}')");
  const proof = await keepStep(query, { step: 'lead', ref: 'proof:lead-1', visitor: 'visitor-proof', touch_id: 'proof-touch', email_key: emailKey('proof@example.com'), source: { utm_content: 'proof', utm_source: 'proof' }, joined_by: 'touch' });
  assert.deepEqual(proof, { kept: true });
  assert.deepEqual((await db.query("SELECT is_proof FROM journey_steps WHERE ref = 'proof:lead-1'")).rows, [{ is_proof: true }]);
  // Counted by no view: not in the resolved steps, and the funnel counts the one real visitor only.
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_resolved_steps WHERE ref = 'proof:lead-1'")).rows[0].n, 0);
  assert.deepEqual((await db.query('SELECT sum(visitors)::int AS visitors, sum(leads)::int AS leads FROM funnel_by_source')).rows, [{ visitors: 1, leads: 0 }]);
  // A check keeps nothing and sets nothing for its visitor, whatever else it carries.
  assert.deepEqual(await keepStep(query, { step: 'visit', visitor: 'visitor-check', source: { utm_content: 'check', utm_source: 'test' }, joined_by: 'cookie' }), { kept: false });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_steps WHERE visitor = 'visitor-check'")).rows[0].n, 0);
  // A real lead from long ago is not a proof: it stays through the purge.
  await db.query("INSERT INTO journey_steps (step, ref, visitor, joined_by, at) VALUES ('lead', 'real-lead-1', 'visitor-real', 'cookie', now() - interval '30 hours')");
  // Young proof rows stay until they are 24 hours old.
  const young = await runKeepSteps({ input: {}, connection: 'held', connect: connection });
  assert.deepEqual(young.proof, { touches: 0, steps: 0 });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_steps WHERE ref = 'proof:lead-1'")).rows[0].n, 1);
  // Aged past 24 hours: the proof's step and the touch only the proof made go; the real lead and the real click stay.
  await db.query("UPDATE journey_steps SET at = now() - interval '25 hours' WHERE is_proof");
  await db.query("UPDATE journey_touches SET made_at = now() - interval '25 hours' WHERE id = 'proof-touch'");
  const aged = await runKeepSteps({ input: {}, connection: 'held', connect: connection });
  assert.deepEqual(aged.proof, { touches: 1, steps: 1 });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_steps WHERE ref = 'proof:lead-1'")).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_touches WHERE id = 'proof-touch'")).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_steps WHERE ref = 'real-lead-1' AND NOT is_proof")).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_steps WHERE step = 'click' AND touch_id = 'touch-1'")).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_touches WHERE id = 'touch-1'")).rows[0].n, 1);
});

// The kit's schema as it was before is_proof: the column and the proof exclusions taken out of the file, so an apply adds them.
function kitBeforeProof() {
  const cut = (text, from, to) => {
    assert.equal(text.split(from).length - 1, 1, from);
    return text.replace(from, to);
  };
  let text = cut(journeySql, 'ALTER TABLE journey_steps ADD COLUMN IF NOT EXISTS is_proof boolean NOT NULL DEFAULT false;', '');
  text = cut(text, 'AND visitor IS NOT NULL AND NOT is_proof', 'AND visitor IS NOT NULL');
  text = cut(text, 'WHERE NOT s.is_proof AND (s.ref IS NULL', 'WHERE (s.ref IS NULL');
  return cut(text, "WHERE s.step = 'visit' AND NOT s.is_proof", "WHERE s.step = 'visit'");
}

test('a reader role granted SELECT on a kit view still has it after an apply that changes the view; a current database applies nothing', async () => {
  const older = new PGlite();
  await older.exec(kitBeforeProof());
  await older.exec('CREATE ROLE kit_reader; GRANT SELECT ON funnel_by_source TO kit_reader;');
  const viewBefore = (await older.query("SELECT oid::int AS oid FROM pg_class WHERE relname = 'funnel_by_source'")).rows[0].oid;
  const applied = await runKeepSteps({ input: {}, connection: 'held', connect: connectTo(older) });
  assert.equal(applied.schema, 'applied');
  assert.equal((await older.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'journey_steps' AND column_name = 'is_proof'")).rows[0].n, 1);
  // The view was dropped and created again (its oid changed), and the reader's grant is back on it.
  assert.notEqual((await older.query("SELECT oid::int AS oid FROM pg_class WHERE relname = 'funnel_by_source'")).rows[0].oid, viewBefore);
  assert.deepEqual((await older.query("SELECT has_table_privilege('kit_reader', 'funnel_by_source', 'SELECT') AS granted")).rows, [{ granted: true }]);
  await older.exec('SET ROLE kit_reader');
  const read = await older.query('SELECT count(*)::int AS n FROM funnel_by_source');
  await older.exec('RESET ROLE');
  assert.deepEqual(read.rows, [{ n: 0 }]);
  // A current database: no DDL, the view is the same object and the grant is untouched.
  const viewNow = (await older.query("SELECT oid::int AS oid FROM pg_class WHERE relname = 'funnel_by_source'")).rows[0].oid;
  const again = await runKeepSteps({ input: {}, connection: 'held', connect: connectTo(older) });
  assert.equal(again.schema, 'current');
  assert.equal((await older.query("SELECT oid::int AS oid FROM pg_class WHERE relname = 'funnel_by_source'")).rows[0].oid, viewNow);
  assert.deepEqual((await older.query("SELECT has_table_privilege('kit_reader', 'funnel_by_source', 'SELECT') AS granted")).rows, [{ granted: true }]);
});

test('check mode reports a kit column the database lacks, and a current database reports none missing', async () => {
  const older = new PGlite();
  await older.exec(kitBeforeProof());
  const lacking = await runKeepSteps({ input: { mode: 'check' }, connection: 'held', connect: connectTo(older) });
  assert.deepEqual(lacking.missing, ['journey_steps.is_proof']);
  assert.equal(lacking.applied, false);
  const current = await pursuitDatabase();
  const whole = await runKeepSteps({ input: { mode: 'check' }, connection: 'held', connect: connectTo(current) });
  assert.deepEqual(whole.missing, []);
});

test('a step of a proof visitor, or of a proof email, is a proof step: the lead by the same visitor and the booking or sale by the same email are proofs too', async () => {
  const db = await pursuitDatabase();
  const query = (sql, params) => db.query(sql, params);
  await keepStep(query, { step: 'visit', visitor: 'visitor-prove', source: { utm_content: 'proof', utm_source: 'site' }, joined_by: 'cookie' });
  await keepStep(query, leadStep({ visitor: 'visitor-prove', email: 'Confirm@Example.com' }));
  assert.deepEqual((await db.query("SELECT step, is_proof FROM journey_steps WHERE visitor = 'visitor-prove' ORDER BY id")).rows, [
    { step: 'visit', is_proof: true },
    { step: 'lead', is_proof: true },
  ]);
  // A proof lead by email, then a TidyCal booking and a sale carrying the same email: no visitor, the email joins them.
  await keepStep(query, leadStep({ email: 'proof-lead@example.com', source: { utm_content: 'proof' } }));
  await db.query(`INSERT INTO statements (key, source, place, meaning, after, at) VALUES ('bk-proof', 'tidycal-api-token', 'booking', 'booked', '{"email":"proof-lead@example.com","starts_at":"2026-11-30T10:00:00Z"}', '2026-11-22T10:00:00Z')`);
  await keepStepsFromRows({ query, mappings: [mappings[0]] });
  await keepStep(query, { step: 'sale', ref: 'pe-proof', email_key: emailKey('proof-lead@example.com'), offer_id: 'offer:course', value_cents: 900, joined_by: 'email' });
  assert.deepEqual((await db.query("SELECT ref, is_proof FROM journey_steps WHERE email_key = $1 ORDER BY id", [emailKey('proof-lead@example.com')])).rows, [
    { ref: null, is_proof: true },
    { ref: 'tidycal:bk-proof', is_proof: true },
    { ref: 'pe-proof', is_proof: true },
  ]);
});

test('a real visitor and a real email keep real steps; a check visit keeps nothing, and its visitor has no step after it', async () => {
  const db = await pursuitDatabase();
  const query = (sql, params) => db.query(sql, params);
  await keepStep(query, { step: 'visit', visitor: 'visitor-real-2', source: { utm_source: 'instagram' }, joined_by: 'cookie' });
  await keepStep(query, leadStep({ visitor: 'visitor-real-2', email: 'real@example.com' }));
  assert.deepEqual((await db.query("SELECT step, is_proof FROM journey_steps WHERE visitor = 'visitor-real-2' ORDER BY id")).rows, [
    { step: 'visit', is_proof: false },
    { step: 'lead', is_proof: false },
  ]);
  assert.deepEqual(await keepStep(query, { step: 'visit', visitor: 'visitor-check-2', source: { utm_content: 'check' }, joined_by: 'cookie' }), { kept: false });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM journey_steps WHERE visitor = 'visitor-check-2'")).rows[0].n, 0);
});
