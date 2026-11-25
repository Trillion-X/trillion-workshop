// tool:keep-a-site-write on a real Postgres engine (PGlite): each named write of read-data/site-writes.json keeps what the site's
// run-sql action row kept, from values only; a write it does not have, a value it does not take, a missing required value and a
// value past its most are refused before anything is sent. The writer login's grants are proved in run-sql-in-my-database's
// writer-under-a-use test. Every value is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { keepASiteWrite, statementOf } from '../do-work/keep-a-site-write.ts';

const DDL = `
  create table statements (id bigint generated always as identity primary key, source text not null, told text not null, place text, meaning text, at timestamptz, key text, after jsonb);
  create table offers (id text primary key);
  insert into offers values ('offer:one'), ('offer:two');
  create table price_views (offer_id text not null, day date not null, views integer not null default 0, primary key (offer_id, day));
  create table welcome_series_stops (email text not null, token text not null, stopped_at timestamptz);
  insert into welcome_series_stops values ('made.up@example.test', 'made-up-token', null);
  create function stop_welcome_series(token text) returns boolean language sql security definer set search_path = public, pg_temp as $$
    with s as (update welcome_series_stops set stopped_at = coalesce(stopped_at, now()) where welcome_series_stops.token = $1 and $1 <> '' returning 1) select exists (select 1 from s) $$;
`;

async function fresh() {
  const db = new PGlite();
  await db.exec(DDL);
  const query = async (sql: string, params: unknown[] = []) => {
    const answer = await db.query(sql, params);
    return { rows: answer.rows as Record<string, unknown>[], row_count: answer.affectedRows ?? answer.rows.length };
  };
  return { db, query };
}
const one = async (db: PGlite, sql: string) => (await db.query(sql)).rows as Record<string, unknown>[];

test('a lead is kept as the action row kept it, and only when the email has an email\'s shape', async () => {
  const { db, query } = await fresh();
  const kept = await keepASiteWrite({ write: 'site-lead', values: { key: 'k1', email: 'Made.Up@Example.test', name: ' A Name ', self_reported: '', offer_id: 'offer:one', visitor: null } }, query);
  assert.deepEqual(kept, { write: 'site-lead', row_count: 1, rows: [] });
  assert.deepEqual(await one(db, "select told, meaning, after from statements where key = 'k1'"),
    [{ told: 'site-form:lead:k1', meaning: 'lead', after: { email: 'made.up@example.test', name: 'A Name', offer_id: 'offer:one' } }]);
  assert.equal((await keepASiteWrite({ write: 'site-lead', values: { key: 'k2', email: 'not an email' } }, query)).row_count, 0);
  // The shape is checked on the email as sent, as the action row's statement did: a padded one is not kept.
  assert.equal((await keepASiteWrite({ write: 'site-lead', values: { key: 'k3', email: ' made.up@example.test' } }, query)).row_count, 0);
});

test('a visit is kept only when its address is on the request\'s origin', async () => {
  const { db, query } = await fresh();
  const visit = (key: string, hrefOrigin: string) => keepASiteWrite({ write: 'site-visit', values: { key, visitor: 'v1', href: `${hrefOrigin}/`, referrer: '', href_origin: hrefOrigin, origin: 'https://example.test' } }, query);
  assert.equal((await visit('v-own', 'https://example.test')).row_count, 1);
  assert.equal((await visit('v-other', 'https://elsewhere.test')).row_count, 0);
  assert.deepEqual(await one(db, "select key, told, after->>'visitor' as visitor from statements"), [{ key: 'v-own', told: 'site-visit:visit:v-own', visitor: 'v1' }]);
});

test('a price view counts each offer that exists once a day', async () => {
  const { db, query } = await fresh();
  for (let n = 0; n < 2; n += 1) await keepASiteWrite({ write: 'price-view', values: { offer_ids: ['offer:one', 'offer:none'] } }, query);
  assert.deepEqual(await one(db, 'select offer_id, views from price_views'), [{ offer_id: 'offer:one', views: 2 }]);
});

test('the welcome stop answers where to go: stopped for a token that matched, invalid for one that did not or none', async () => {
  const { db, query } = await fresh();
  const stop = (token: string | null) => keepASiteWrite({ write: 'welcome-series-stop', values: { token, stopped_path: '/stopped', invalid_path: '/invalid' } }, query);
  assert.deepEqual((await stop('made-up-token')).rows, [{ goto: '/stopped' }]);
  assert.deepEqual((await stop('no-such-token')).rows, [{ goto: '/invalid' }]);
  assert.deepEqual((await stop(null)).rows, [{ goto: '/invalid' }]);
  assert.equal((await one(db, 'select count(*)::int as n from welcome_series_stops where stopped_at is not null'))[0].n, 1);
});

test('only a named write with the values it takes is sent: never SQL from the input', () => {
  assert.throws(() => statementOf({ write: 'drop-everything', values: {} }), /write must be one of site-lead, site-visit, price-view, welcome-series-stop/);
  assert.throws(() => statementOf({ write: 'site-lead', values: { key: 'k', sql: 'delete from statements' } }), /takes no sql/);
  assert.throws(() => statementOf({ write: 'site-lead', values: { email: 'made.up@example.test' } }), /needs key/);
  assert.throws(() => statementOf({ write: 'site-lead', values: { key: 'k', email: 'x'.repeat(321) } }), /at most 320 characters/);
  assert.throws(() => statementOf({ write: 'price-view', values: { offer_ids: Array.from({ length: 21 }, (_, n) => `offer:${n}`) } }), /at most 20 texts/);
  assert.throws(() => statementOf({ write: 'site-lead', values: [] }), /values must be an object/);
  assert.deepEqual(statementOf({ write: 'price-view', values: { offer_ids: ['offer:one'] } }).params, [['offer:one']]);
});
