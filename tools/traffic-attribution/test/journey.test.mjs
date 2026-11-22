// tools/traffic-attribution/test/journey.test.mjs
// The journey kit (do-work/journey.mjs): the visitor cookie, the source a page keeps, the /go/ redirect, checkout fields
// within Stripe's limits, the booking and the sale joined to a visitor, and the SQL that holds them. The SQL runs in
// PGlite (the repository's own Postgres), twice, so its idempotence is checked where it is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { visitorOf, consentGrantedOf, sourceOf, visitStep, keepStep, goRedirect, visitBeacon, checkoutAttribution, bookedStep, bookingStepOf, leadStep, saleStepOf, emailKey, makeTouch } from '../do-work/journey.mjs';
import { makeATrackedLink } from '../do-work/make-a-tracked-link.mjs';

const sql = readFileSync(resolve(import.meta.dirname, '../read-data/journey-steps.sql'), 'utf8');
const SITE = 'https://site.example';

async function database() {
  const db = new PGlite();
  await db.exec(sql);
  const query = (statement, params) => db.query(statement, params);
  return { db, query };
}

async function writeTouch(query, touch) {
  await query('INSERT INTO journey_touches (id, destination, source, post_id) VALUES ($1, $2, $3::jsonb, $4)', [touch.row.id, touch.row.destination, JSON.stringify(touch.row.source), touch.row.post_id]);
}

test('a visitor keeps the cookie they came with, and gets a new one with its attributes when it is absent or malformed', () => {
  const first = visitorOf('', undefined, { consent: true });
  assert.match(first.visitor, /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(first.setCookie, `jv=${first.visitor}; Max-Age=34128000; Path=/; SameSite=Lax; HttpOnly; Secure`);
  assert.deepEqual(visitorOf(`theme=dark; jv=${first.visitor}`, undefined, { consent: true }), { visitor: first.visitor, setCookie: null });
  const malformed = visitorOf('jv=not a valid value!', undefined, { consent: true });
  assert.notEqual(malformed.visitor, 'not a valid value!');
  assert.ok(malformed.setCookie.startsWith(`jv=${malformed.visitor};`));
});

test('a page keeps only its kept parameters and the ad click ids, with the referrer host and the landing path', () => {
  assert.deepEqual(
    sourceOf('/offer?utm_source=instagram&secret=1&gclid=abc', 'https://www.instagram.com/p/x'),
    { utm_source: 'instagram', gclid: 'abc', referrer_host: 'www.instagram.com', landing_path: '/offer' },
  );
  assert.deepEqual(sourceOf('/offer?secret=1', 'https://news.example/'), {});
  assert.deepEqual(sourceOf('/offer'), {});
  assert.deepEqual(sourceOf('/offer?utm_source=%20%20'), {});
  assert.deepEqual(sourceOf('/offer?utm_source=x'), { utm_source: 'x', landing_path: '/offer' });
});

test('a visit step is kept only for a page that came with a source, and joins to its touch by t', () => {
  assert.equal(visitStep({ url: '/offer', refererHeader: '', visitor: 'visitor-one-1' }), null);
  const step = visitStep({ url: '/offer?utm_source=instagram&t=touch-1', refererHeader: '', visitor: 'visitor-one-1' });
  assert.equal(step.step, 'visit');
  assert.equal(step.touch_id, 'touch-1');
  assert.equal(step.joined_by, 'touch');
});

test('a /go/ link keeps a click for the visitor and redirects with the touch fields and touch id; an unknown id is 404', async () => {
  const { query } = await database();
  const touch = makeTouch({ destination: 'https://tidycal.com/acme/call?x=1', source: { utm_source: 'instagram', utm_campaign: 'reel-12', secret: 'no' }, post_id: 'reel-12', base: `${SITE}/some/path` });
  assert.equal(touch.short_link, `${SITE}/go/${touch.row.id}`);
  assert.deepEqual(touch.row.source, { utm_source: 'instagram', utm_campaign: 'reel-12' });
  await writeTouch(query, touch);

  const went = await goRedirect(query, touch.row.id, { cookieHeader: '', refererHeader: 'https://www.instagram.com/', consent: true });
  assert.equal(went.status, 302);
  const location = new URL(went.location);
  assert.equal(`${location.origin}${location.pathname}`, 'https://tidycal.com/acme/call');
  assert.equal(location.searchParams.get('x'), '1');
  assert.equal(location.searchParams.get('utm_source'), 'instagram');
  assert.equal(location.searchParams.get('utm_campaign'), 'reel-12');
  assert.equal(location.searchParams.get('secret'), null);
  assert.equal(location.searchParams.get('t'), touch.row.id);
  const visitor = went.setCookie.split(';')[0].slice('jv='.length);
  const { rows } = await query('SELECT step, touch_id, visitor, joined_by, source->>\'referrer_host\' AS host FROM journey_steps');
  assert.deepEqual(rows, [{ step: 'click', touch_id: touch.row.id, visitor, joined_by: 'touch', host: 'www.instagram.com' }]);

  assert.deepEqual(await goRedirect(query, 'no-such-touch'), { status: 404, location: null, setCookie: null });
});

test('checkout fields stay inside Stripe\'s limits: invalid characters dropped, lengths capped, empty values left out', () => {
  const out = checkoutAttribution(`abc def/${'x'.repeat(300)}`, { utm_source: 'a'.repeat(600), utm_campaign: 'spring', gclid: 'g', [`${'k'.repeat(41)}`]: 'too long a key' });
  assert.match(out.client_reference_id, /^[A-Za-z0-9_-]{1,200}$/);
  assert.equal(out.client_reference_id.length, 200);
  assert.equal(out.metadata.utm_source.length, 500);
  assert.equal(out.metadata.utm_campaign, 'spring');
  assert.equal(out.metadata.gclid, 'g');
  assert.equal(Object.keys(out.metadata).some(key => key.length > 40), false);
  assert.deepEqual(checkoutAttribution(''), {});
});

test('a booking keeps the email as its key, never the email, once per booking, and carries the visitor from the cookie', async () => {
  const { query } = await database();
  const step = bookedStep({ params: { email: ' Ana@Example.com ', starts: '2026-11-25T10:00:00Z', type: 'Discovery call' }, visitor: 'visitor-one-1' });
  assert.equal(step.email_key, emailKey('ana@example.com'));
  assert.match(step.email_key, /^1f:[0-9a-f]{64}$/);
  assert.equal(step.ref, `${step.email_key}:2026-11-25T10:00:00Z`);
  assert.equal(step.joined_by, 'cookie');
  assert.equal(step.offer_id, 'Discovery call');
  assert.equal(bookedStep({ params: {} }), null);
  await keepStep(query, step);
  assert.deepEqual(await keepStep(query, step), { kept: false });
  const { rows } = await query('SELECT * FROM journey_steps');
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes('ana@example.com'), false);
});

test('a paid session joins to its visitor by client_reference_id, or by the email when no visitor is on it', () => {
  const paid = saleStepOf({ id: 'cs_1', client_reference_id: 'visitor-one-1', customer_details: { email: 'ANA@example.com ' }, amount_total: 4900, metadata: { offer_id: 'course' } });
  assert.equal(paid.visitor, 'visitor-one-1');
  assert.equal(paid.joined_by, 'client_reference_id');
  assert.equal(paid.email_key, emailKey('ana@example.com'));
  assert.equal(paid.offer_id, 'course');
  assert.equal(paid.value_cents, 4900);
  assert.equal(paid.ref, 'cs_1');

  const byEmail = saleStepOf({ id: 'cs_2', customer_email: 'ana@example.com', amount_total: 9900, metadata: {} });
  assert.equal(byEmail.visitor, null);
  assert.equal(byEmail.joined_by, 'email');
  assert.equal(byEmail.email_key, paid.email_key);
});

test('the tracked-link tool answers a touch row and a short link only when given go_base', () => {
  const input = { destination: 'https://shop.example/offer', project: 'spring-launch', source: 'instagram', campaign: 'reel-12', content: 'reel-12-a' };
  const plain = makeATrackedLink(input);
  assert.deepEqual(Object.keys(plain), ['link', 'fields']);
  const withBase = makeATrackedLink({ ...input, go_base: SITE });
  assert.equal(withBase.link, plain.link);
  assert.match(withBase.short_link, /^https:\/\/site\.example\/go\/[A-Za-z0-9_-]{12}$/);
  assert.deepEqual(withBase.touch, {
    id: withBase.short_link.split('/go/')[1],
    destination: 'https://shop.example/offer',
    source: { bf_project: 'spring-launch', utm_source: 'instagram', utm_campaign: 'reel-12', utm_content: 'reel-12-a' },
    post_id: 'reel-12-a',
    offer_id: null,
  });
});

test('the SQL applies twice cleanly, and a booking joined only by email counts toward the source of the visitor it belongs to', async () => {
  const { db, query } = await database();
  await db.exec(sql);
  const touch = makeTouch({ destination: `${SITE}/offer`, source: { utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'reel-12' }, base: SITE });
  await writeTouch(query, touch);
  await goRedirect(query, touch.row.id, { visitor: 'visitor-a-1', consent: true });
  await keepStep(query, { visitor: 'visitor-a-1', step: 'lead', email_key: emailKey('a@example.com'), joined_by: 'cookie' });
  await keepStep(query, bookedStep({ params: { email: 'a@example.com', starts: '2026-11-25' }, visitor: null }));
  await keepStep(query, saleStepOf({ id: 'cs_9', customer_details: { email: 'nobody@example.com' }, amount_total: 1000 }));

  const funnel = (await query('SELECT * FROM funnel_by_source')).rows.map(row => ({
    ...row,
    visitors: Number(row.visitors), clicks: Number(row.clicks), visits: Number(row.visits), leads: Number(row.leads),
    bookings: Number(row.bookings), checkouts: Number(row.checkouts), sales: Number(row.sales), revenue_cents: Number(row.revenue_cents),
  }));
  const instagram = funnel.find(row => row.utm_source === 'instagram');
  assert.deepEqual(instagram, {
    utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'reel-12',
    visitors: 1, clicks: 1, visits: 0, leads: 1, bookings: 1, checkouts: 0, sales: 0, revenue_cents: 0,
  });
  const unknown = funnel.find(row => row.utm_source === null);
  assert.equal(unknown.visitors, 1);
  assert.equal(unknown.sales, 1);
  assert.equal(unknown.revenue_cents, 1000);
});

test('a kept booking row becomes an email-keyed booking step with no visitor; a cancelled one keeps no step', () => {
  const step = bookingStepOf({ id: 'tidycal-1', booker_email: ' Ana@Example.com ', starts_at: '2026-11-25T10:00:00Z', booking_type: 'Discovery call', status: 'active' });
  assert.deepEqual(
    { step: step.step, ref: step.ref, joined_by: step.joined_by, visitor: step.visitor, source: step.source, offer_id: step.offer_id },
    { step: 'booking', ref: 'tidycal-1', joined_by: 'email', visitor: null, source: null, offer_id: 'Discovery call' },
  );
  assert.equal(step.email_key, emailKey('ana@example.com'));
  assert.equal(JSON.stringify(step).includes('Ana@Example.com'), false);
  assert.equal(bookingStepOf({ id: 'tidycal-2', booker_email: 'a@example.com', status: 'cancelled' }), null);
});

test('a lead step keeps the email key and the self-reported answer, never the raw email or the name', () => {
  const step = leadStep({ visitor: 'visitor-one-1', email: 'Ana@Example.com', offer_id: 'course', source: { utm_source: 'instagram', secret: 'x' }, self_reported: ' a friend ' });
  assert.equal(step.step, 'lead');
  assert.equal(step.email_key, emailKey('ana@example.com'));
  assert.deepEqual(step.source, { utm_source: 'instagram', self_reported: 'a friend' });
  assert.equal(step.joined_by, 'cookie');
  assert.equal(JSON.stringify(step).includes('Ana@Example.com'), false);
  assert.throws(() => leadStep({ email: '  ' }), TypeError);
});

test('a booking made from the site joins to the visitor whose lead step carried the same email, and self-reported is not a touch', async () => {
  const { query } = await database();
  await keepStep(query, leadStep({ visitor: 'visitor-b-1', email: 'b@example.com', source: { self_reported: 'podcast' } }));
  await keepStep(query, bookingStepOf({ id: 'tidycal-9', booker_email: 'B@example.com', starts_at: '2026-11-26T09:00:00Z', booking_type: 'Lesson', status: 'active' }));
  const { rows } = await query('SELECT person, step FROM journey_resolved_steps ORDER BY step');
  assert.deepEqual(rows, [{ person: 'visitor-b-1', step: 'booking' }, { person: 'visitor-b-1', step: 'lead' }]);
  const first = await query('SELECT * FROM journey_first_touch');
  assert.equal(first.rows.length, 0);
  const funnel = (await query('SELECT utm_source, visitors, leads, bookings FROM funnel_by_source')).rows;
  assert.deepEqual(funnel.map(row => ({ ...row, visitors: Number(row.visitors), leads: Number(row.leads), bookings: Number(row.bookings) })), [
    { utm_source: null, visitors: 1, leads: 1, bookings: 1 },
  ]);
});

test('without consent (the default) a visitor gets no id and no cookie, and a step keeps only its touch id', async () => {
  assert.deepEqual(visitorOf('jv=abcdefgh12345678'), { visitor: null, setCookie: null });
  const { query } = await database();
  const touch = makeTouch({ destination: `${SITE}/offer`, source: { utm_source: 'instagram' }, base: SITE });
  await writeTouch(query, touch);
  const went = await goRedirect(query, touch.row.id, { cookieHeader: '' });
  assert.equal(went.status, 302);
  assert.equal(went.setCookie, null);
  const { rows } = await query('SELECT visitor, touch_id FROM journey_steps');
  assert.deepEqual(rows, [{ visitor: null, touch_id: touch.row.id }]);
});

test('a database that cannot be read answers 503 with a retry time, and a failed click write still redirects', async () => {
  const broken = async () => { throw new Error('connection refused'); };
  assert.deepEqual(await goRedirect(broken, 'any-touch'), { status: 503, location: null, setCookie: null, retryAfter: 30 });

  const { db, query } = await database();
  const touch = makeTouch({ destination: `${SITE}/offer`, source: { utm_source: 'instagram' }, base: SITE });
  await writeTouch(query, touch);
  const writesFail = async (sql, params) => {
    if (/INSERT INTO journey_steps/.test(sql)) throw new Error('disk full');
    return query(sql, params);
  };
  const went = await goRedirect(writesFail, touch.row.id, { consent: false });
  assert.equal(went.status, 302);
  assert.match(went.location, /utm_source=instagram/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM journey_steps')).rows[0].n, 0);
});

test('a beacon from a static page keeps the visit of its own origin, and ignores a foreign origin or an oversized body', async () => {
  const { query } = await database();
  const body = JSON.stringify({ href: `${SITE}/offer?utm_source=instagram&t=touch-9` });
  const answer = await visitBeacon(query, { body, siteOrigin: SITE, cookieHeader: '', consent: true });
  assert.equal(answer.status, 204);
  assert.match(answer.setCookie, /^jv=/);
  const kept = (await query("SELECT step, touch_id, visitor FROM journey_steps")).rows;
  assert.deepEqual(kept.map(row => ({ step: row.step, touch_id: row.touch_id })), [{ step: 'visit', touch_id: 'touch-9' }]);

  assert.deepEqual(await visitBeacon(query, { body: JSON.stringify({ href: 'https://elsewhere.example/offer?utm_source=x' }), siteOrigin: SITE }), { status: 204, setCookie: null });
  assert.deepEqual(await visitBeacon(query, { body: 'x'.repeat(3000), siteOrigin: SITE }), { status: 204, setCookie: null });
  assert.equal((await query('SELECT count(*)::int AS n FROM journey_steps')).rows[0].n, 1);
});

test('the site consent cookie decides consent: granted keeps the visitor, denied or absent keeps none', () => {
  assert.equal(consentGrantedOf('site_consent=granted'), true);
  assert.equal(consentGrantedOf('site_consent=denied'), false);
  assert.equal(consentGrantedOf('jv=abcdefgh12345678'), false);
  const granted = visitorOf('site_consent=granted');
  assert.match(granted.visitor, /^[A-Za-z0-9_-]{8,128}$/);
  assert.deepEqual(visitorOf('site_consent=denied'), { visitor: null, setCookie: null });
});

