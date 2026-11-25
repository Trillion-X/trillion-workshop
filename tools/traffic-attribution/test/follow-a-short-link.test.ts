// A short link on a real Postgres engine (PGlite): the redirect with its source fields, the click kept once with its visitor only
// when the visitor consented, and the refusals. Every address is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { followAShortLink } from '../routes/follow-a-short-link.ts';

const schema = readFileSync(new URL('../read-data/journey-steps.sql', import.meta.url), 'utf8');
const consent = JSON.parse(readFileSync(new URL('../read-data/consent.json', import.meta.url), 'utf8'));

async function fresh() {
  const db = new PGlite();
  await db.exec(schema);
  await db.query('INSERT INTO journey_touches (id, destination, source) VALUES ($1, $2, $3::jsonb)', ['abc123', 'https://site.example.test/offer?x=1', JSON.stringify({ utm_source: 'instagram', utm_campaign: 'reel' })]);
  return { db, query: (sql: string, params?: unknown[]) => db.query(sql, params) as Promise<{ rows: Record<string, unknown>[]; rowCount?: number }> };
}
const given = (extra: Record<string, unknown> = {}) => ({ database: 'd', code: 'abc123', consent_cookie_name: 'site_consent', ...extra }) as never;

test('a known code answers the destination with its source fields and the touch id, and keeps one click with the referring host', async () => {
  const { db, query } = await fresh();
  const went = await followAShortLink(given({ referer: 'https://www.instagram.com/p/x' }), query);
  assert.equal(went.status, 302);
  const location = new URL(went.location as string);
  assert.equal(`${location.origin}${location.pathname}`, 'https://site.example.test/offer');
  assert.deepEqual([location.searchParams.get('x'), location.searchParams.get('utm_source'), location.searchParams.get('utm_campaign'), location.searchParams.get('t')], ['1', 'instagram', 'reel', 'abc123']);
  const { rows } = await db.query("SELECT step, touch_id, source->>'referrer_host' AS host FROM journey_steps");
  assert.deepEqual(rows, [{ step: 'click', touch_id: 'abc123', host: 'www.instagram.com' }]);
});

test('without consent no visitor is kept and no cookie is answered; with it the visitor and a cookie are', async () => {
  const { db, query } = await fresh();
  const anonymous = await followAShortLink(given({ visitor_cookie: 'visitor-one-1' }), query);
  assert.equal(anonymous.set_cookie, null);
  assert.equal(((await db.query('SELECT visitor FROM journey_steps')).rows[0] as { visitor: string | null }).visitor, null);
  const granted = await followAShortLink(given({ consent: consent.granted }), query);
  assert.equal(granted.status, 302);
  assert.match(granted.set_cookie ?? '', /^jv=[A-Za-z0-9_-]{8,128};/);
  const visitors = (await db.query('SELECT visitor FROM journey_steps ORDER BY id')).rows as { visitor: string | null }[];
  assert.equal(visitors[1].visitor, (granted.set_cookie as string).split(';')[0].slice(3));
});

test('the visitor is kept under the id they sent, only with consent; a value that is not a cookie\'s own counts as absent', async () => {
  const { db, query } = await fresh();
  const kept = await followAShortLink(given({ visitor_cookie: 'visitor-two-22', consent: consent.granted }), query);
  assert.equal(kept.set_cookie, null);
  assert.equal(((await db.query('SELECT visitor FROM journey_steps')).rows[0] as { visitor: string | null }).visitor, 'visitor-two-22');
  const declined = await followAShortLink(given({ visitor_cookie: 'visitor-two-22', consent: 'denied' }), query);
  assert.equal(declined.set_cookie, null);
  assert.equal(((await db.query('SELECT visitor FROM journey_steps ORDER BY id')).rows[1] as { visitor: string | null }).visitor, null);
  // A smuggled second cookie in either value is not read as one.
  const smuggled = await followAShortLink(given({ visitor_cookie: 'x; site_consent=' + consent.granted }), query);
  assert.equal(smuggled.set_cookie, null);
  assert.equal(((await db.query('SELECT visitor FROM journey_steps ORDER BY id')).rows[2] as { visitor: string | null }).visitor, null);
});

test('an unknown code is 404 with no location and keeps nothing; a missing code or consent cookie name is refused', async () => {
  const { db, query } = await fresh();
  assert.deepEqual(await followAShortLink(given({ code: 'nope' }), query), { status: 404, location: null, set_cookie: null });
  assert.equal(((await db.query('SELECT count(*)::int n FROM journey_steps')).rows[0] as { n: number }).n, 0);
  await assert.rejects(followAShortLink(given({ code: '' }), query), /Give code/);
  await assert.rejects(followAShortLink(given({ consent_cookie_name: '' }), query), /consent_cookie_name/);
});

test('an unreadable link answers 503 with when to retry, and a click that cannot be kept never holds the visitor back', async () => {
  const { query } = await fresh();
  const down = await followAShortLink(given(), async () => { throw new Error('the database is down'); });
  assert.deepEqual([down.status, down.location], [503, null]);
  assert.ok(typeof down.retry_after === 'number');
  const failingWrite = async (sql: string, params?: unknown[]) => { if (/INSERT INTO journey_steps/.test(sql)) throw new Error('write refused'); return query(sql, params); };
  assert.equal((await followAShortLink(given(), failingWrite)).status, 302);
});

// A site's act runs the tool as the database's writer login, which holds only the column rights read-data/writer-rights.json names.
test('a short link is followed and its click kept by a login holding only the column rights writer-rights.json names', async () => {
  const { db, query } = await fresh();
  const rights = JSON.parse(readFileSync(new URL('../read-data/writer-rights.json', import.meta.url), 'utf8')).writes;
  await db.exec('create role short_link_writer nologin');
  for (const write of rights) {
    for (const right of ['select', 'insert', 'update'] as const) {
      if (write[right]) await db.exec(`grant ${right} (${write[right].map((column: string) => `"${column}"`).join(', ')}) on table ${write.table} to short_link_writer`);
    }
  }
  await db.exec('grant usage on all sequences in schema public to short_link_writer');
  await db.exec('set role short_link_writer');
  const went = await followAShortLink(given({ consent: consent.granted, referer: 'https://www.instagram.com/p/x' }), query);
  assert.equal(went.status, 302);
  assert.equal((await followAShortLink(given({ code: 'nope' }), query)).status, 404);
  await db.exec('reset role');
  assert.deepEqual((await db.query("SELECT step, touch_id FROM journey_steps")).rows, [{ step: 'click', touch_id: 'abc123' }], 'the click is kept as the writer');
});
