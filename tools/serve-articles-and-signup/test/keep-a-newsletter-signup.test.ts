// The newsletter signup on a real Postgres engine (PGlite): the double opt-in, its limits and the one-click unsubscribe. Every
// address is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { keepANewsletterSignup, type Given } from '../routes/keep-a-newsletter-signup.ts';

const SECRET = 'a-made-up-secret-of-at-least-32-characters';
const signup = { consent: 'You agree to get our letter.', confirm: { subject: 'Confirm', body: 'Press the button.', button: 'Confirm now' } };
const DDL = `create table subscribers (id text primary key, email text unique not null, status text not null, confirm_digest text, confirm_sent_at timestamptz, source_path text,
  network_digest text, created_at timestamptz, tags jsonb default '[]', consent_text text, consent_at timestamptz, consent_page text, consent_ip_digest text,
  confirmed_at timestamptz, ended_at timestamptz, ended_reason text)`;
const given = (extra: Partial<Given>): Given => ({ action: 'subscribe', secret: SECRET, origin: 'https://site.example.test', signup, ...extra });

async function fresh() {
  const db = new PGlite();
  await db.exec(DDL);
  const execute = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Record<string, unknown>[];
  let n = 0;
  const clock = { now: () => '2026-11-25T12:00:00.000Z', newId: () => `id-${(n += 1)}`, newToken: () => `token-${(n += 1)}` };
  return { db, execute, clock };
}
const linkParts = (link: string) => { const url = new URL(link); return { s: url.searchParams.get('s') ?? '', t: url.searchParams.get('t') ?? '' }; };

test('a signup is kept pending and answers the confirmation mail; the link confirms it once', async () => {
  const { db, execute, clock } = await fresh();
  const asked = await keepANewsletterSignup(given({ email: ' Sam@Example.test ', ip: '203.0.113.9', source: '/articles/a' }), execute, clock);
  assert.equal(asked.outcome, 'send_confirmation');
  assert.equal(asked.mail?.to, 'sam@example.test');
  assert.match(asked.mail?.text ?? '', /Press the button\.\n\nhttps:\/\/site\.example\.test\/subscribe\/confirm\?s=/);
  const [row] = (await db.query('select * from subscribers')).rows as any[];
  assert.deepEqual([row.status, row.source_path, row.consent_text], ['pending', '/articles/a', signup.consent]);
  assert.ok(!JSON.stringify(row).includes('203.0.113.9'), 'no raw address is kept');
  const { s, t } = linkParts(asked.mail!.link);
  assert.equal((await keepANewsletterSignup(given({ action: 'confirm', s, t: 'wrong' }), execute, clock)).outcome, 'invalid_link');
  assert.equal((await keepANewsletterSignup(given({ action: 'confirm', s, t }), execute, clock)).outcome, 'subscribed');
  assert.equal((await keepANewsletterSignup(given({ action: 'confirm', s, t }), execute, clock)).outcome, 'already_subscribed');
  assert.equal(((await db.query('select status from subscribers')).rows[0] as any).status, 'confirmed');
});

test('a confirm link is good for 72 hours only', async () => {
  const { execute, clock } = await fresh();
  const asked = await keepANewsletterSignup(given({ email: 'sam@example.test' }), execute, clock);
  const { s, t } = linkParts(asked.mail!.link);
  const late = { ...clock, now: () => '2026-11-28T12:00:01.000Z' };
  assert.equal((await keepANewsletterSignup(given({ action: 'confirm', s, t }), execute, late)).outcome, 'invalid_link');
});

test('a bad address, too many from one network, and a suppression are not signed up', async () => {
  const { db, execute, clock } = await fresh();
  assert.equal((await keepANewsletterSignup(given({ email: 'nobody' }), execute, clock)).outcome, 'invalid_email');
  for (let n = 0; n < 5; n += 1) assert.equal((await keepANewsletterSignup(given({ email: `p${n}@example.test`, ip: '198.51.100.1' }), execute, clock)).outcome, 'send_confirmation');
  assert.equal((await keepANewsletterSignup(given({ email: 'p9@example.test', ip: '198.51.100.1' }), execute, clock)).outcome, 'too_many');
  assert.equal((await keepANewsletterSignup(given({ email: 'p9@example.test', ip: '198.51.100.2' }), execute, clock)).outcome, 'send_confirmation');
  await db.query("insert into subscribers (id, email, status) values ('x', 'bounced@example.test', 'bounced')");
  assert.equal((await keepANewsletterSignup(given({ email: 'bounced@example.test', ip: '198.51.100.3' }), execute, clock)).outcome, 'check_inbox');
  assert.equal(((await db.query("select status from subscribers where id = 'x'")).rows[0] as any).status, 'bounced');
});

test('signing up again renews a pending or unsubscribed signup, and a confirmed one only gains tags', async () => {
  const { db, execute, clock } = await fresh();
  const first = await keepANewsletterSignup(given({ email: 'sam@example.test', tags: ['news'] }), execute, clock);
  const again = await keepANewsletterSignup(given({ email: 'sam@example.test', tags: ['news'] }), execute, clock);
  assert.equal(again.attempt?.id, first.attempt?.id);
  assert.notEqual(again.attempt?.digest, first.attempt?.digest);
  const { s, t } = linkParts(again.mail!.link);
  await keepANewsletterSignup(given({ action: 'confirm', s, t }), execute, clock);
  const confirmed = await keepANewsletterSignup(given({ email: 'sam@example.test', source: '/articles/b', source_tags: { '/articles/b': ['b-readers'] } }), execute, clock);
  assert.equal(confirmed.outcome, 'check_inbox');
  assert.deepEqual(((await db.query('select tags from subscribers')).rows[0] as any).tags.sort(), ['b-readers', 'news']);
});

test('a failed mail puts the signup back so it can be tried again; only its own digest does', async () => {
  const { db, execute, clock } = await fresh();
  const asked = await keepANewsletterSignup(given({ email: 'sam@example.test' }), execute, clock);
  await keepANewsletterSignup(given({ action: 'send_failed', id: asked.attempt!.id, digest: 'someone-elses' }), execute, clock);
  assert.notEqual(((await db.query('select confirm_sent_at from subscribers')).rows[0] as any).confirm_sent_at, null);
  await keepANewsletterSignup(given({ action: 'send_failed', id: asked.attempt!.id, digest: asked.attempt!.digest }), execute, clock);
  assert.equal(((await db.query('select confirm_sent_at from subscribers')).rows[0] as any).confirm_sent_at, null);
});

test('an unsubscribe link ends that subscription only, by link or one click, and a wrong link ends nothing', async () => {
  const { db, execute, clock } = await fresh();
  const a = await keepANewsletterSignup(given({ email: 'a@example.test' }), execute, clock);
  const b = await keepANewsletterSignup(given({ email: 'b@example.test' }), execute, clock);
  const keyed = (id: string) => createHmac('sha256', SECRET).update(`unsubscribe\n${id}`).digest('base64url');
  assert.equal((await keepANewsletterSignup(given({ action: 'unsubscribe', s: a.attempt!.id, t: keyed(b.attempt!.id) }), execute, clock)).outcome, 'invalid_link');
  assert.equal((await keepANewsletterSignup(given({ action: 'unsubscribe', s: a.attempt!.id, t: keyed(a.attempt!.id), method: 'POST' }), execute, clock)).outcome, 'unsubscribed');
  const rows = (await db.query('select email, status, ended_reason from subscribers order by email')).rows as any[];
  assert.deepEqual(rows.map(row => [row.email, row.status, row.ended_reason]), [['a@example.test', 'unsubscribed', 'one-click'], ['b@example.test', 'pending', null]]);
  await assert.rejects(keepANewsletterSignup({ ...given({ action: 'unsubscribe' }), secret: 'short' }, execute, clock), /not held/);
});
