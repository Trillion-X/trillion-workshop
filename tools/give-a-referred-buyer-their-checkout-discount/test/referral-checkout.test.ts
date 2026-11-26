// The referral part of a checkout, read from a pursuit's own rows in PGlite: a live code of someone else gives the friend's
// discount as the checkout takes it and the code for the session's metadata; a malformed, unknown or own code, or none, gives
// nothing; a rule the referral rules refuse, or no target row, stops the read. Synthetic people and codes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { referralCheckout } from '../reads/referral-checkout.ts';

const ownCode = readFileSync(new URL('../sql/own-code.sql', import.meta.url), 'utf8');
const readerRights = JSON.parse(readFileSync(new URL('../read-data/reader-rights.json', import.meta.url), 'utf8')) as { reads: { table: string; columns: string[] }[] };

const FRIEND_RULE = {
  label: 'Friend: $25 off the first month', state: 'active', earner: 'friend', reward: 'discount', code_points_at: 'offer_id',
  code_points_at_value: 'offer:membership', offer_ids: ['offer:membership'], amount_cents: 2500, currency: 'usd', duration: 'once',
};
const REFERRER_RULE = {
  label: 'Referrer: $25 credit', state: 'active', earner: 'referrer', reward: 'credit', code_points_at: 'offer_id',
  code_points_at_value: 'offer:membership', offer_ids: ['offer:membership'], amount_cents: 2500, currency: 'usd',
};

// The tables are made by an owner role holding own_code (sql/own-code.sql); the reader holds exactly the columns of
// read-data/reader-rights.json and EXECUTE on own_code, as the site's reader login does, and every read runs as it.
async function database(rules = [FRIEND_RULE, REFERRER_RULE], target = true) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE site_owner; CREATE ROLE site_reader;
    GRANT CREATE, USAGE ON SCHEMA public TO site_owner; GRANT USAGE ON SCHEMA public TO site_reader;
    SET ROLE site_owner;
    CREATE TABLE referral_codes (email text PRIMARY KEY, code text UNIQUE NOT NULL, made_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE referral_reward_rules (id text PRIMARY KEY, value jsonb NOT NULL);
    CREATE TABLE referral_code_target (name text PRIMARY KEY, target_on text NOT NULL, target_value text NOT NULL);
    INSERT INTO referral_codes (email, code) VALUES ('member@example.com', 'SITE-AB12CD');
    ${ownCode}
    RESET ROLE;
  `);
  await db.exec(`SET ROLE site_owner;${readerRights.reads.map(r => `GRANT SELECT (${r.columns.join(', ')}) ON TABLE ${r.table} TO site_reader;`).join('')}RESET ROLE;
    GRANT EXECUTE ON FUNCTION public.own_code(text, text) TO site_reader;`);
  for (const [i, rule] of rules.entries()) await db.query('INSERT INTO referral_reward_rules (id, value) VALUES ($1, $2)', [`referral-reward-rule:${i}`, JSON.stringify(rule)]);
  if (target) await db.query("INSERT INTO referral_code_target (name, target_on, target_value) VALUES ('site', 'offer_id', 'offer:membership')");
  await db.exec('SET ROLE site_reader');
  return Object.assign(async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Record<string, unknown>[], { db });
}

test('a live code of someone else gives the friend\'s discount and the code for the metadata; no email in the answer', async () => {
  const rows = await database();
  const answer = await referralCheckout({ database: 'a_site', code: ' site-ab12cd ', buyer_email: 'friend@example.com', target: 'site' }, rows);
  assert.equal(answer.checkoutCode, 'SITE-AB12CD', 'the code is read the referral rules\' way (trimmed, upper case)');
  assert.equal(answer.adjustments?.length, 1, 'one friend reward, one adjustment');
  assert.deepEqual(answer.metadata, { referral_code: 'SITE-AB12CD' });
  assert.equal(JSON.stringify(answer).includes('@'), false, 'no email leaves the read');
  assert.ok(answer.adjustments?.[0] && typeof answer.adjustments[0] === 'object', 'the adjustment is the checkout code adjustment the checkout takes');
});

test('no code, a malformed or unknown code, or the buyer\'s own gives nothing', async () => {
  const rows = await database();
  for (const code of [undefined, '', '!!', 'SITE-NOPE00']) assert.deepEqual(await referralCheckout({ database: 'a_site', code, target: 'site' }, rows), {});
  assert.deepEqual(await referralCheckout({ database: 'a_site', code: 'SITE-AB12CD', buyer_email: 'Member@Example.com', target: 'site' }, rows), {}, 'a member\'s own code gives them nothing');
});

test('rules with no friend reward give nothing; a refused rule or a missing target stops the read', async () => {
  assert.deepEqual(await referralCheckout({ database: 'a_site', code: 'SITE-AB12CD', target: 'site' }, await database([REFERRER_RULE])), {});
  await assert.rejects(referralCheckout({ database: 'a_site', code: 'SITE-AB12CD', target: 'site' }, await database([{ ...FRIEND_RULE, reward: 'nonsense' }])), /refuse/);
  await assert.rejects(referralCheckout({ database: 'a_site', code: 'SITE-AB12CD', target: 'site' }, await database(undefined, false)), /No referral_code_target row is named site/);
  await assert.rejects(referralCheckout({ database: 'a_site', code: 'SITE-AB12CD', target: '' }, await database()), /Give target/);
});

test('the reader may not read an email; own_code answers for it, true for the owner in any case or padding, false for anyone else, and false rather than an error for odd input', async () => {
  const rows = await database();
  await assert.rejects(rows('select email from referral_codes'), /permission denied/, 'the reader reads no email');
  await assert.rejects(rows('select * from referral_codes'), /permission denied/);
  assert.deepEqual(await rows('select code, made_at from referral_codes'), [{ code: 'SITE-AB12CD', made_at: (await rows('select made_at from referral_codes'))[0].made_at }], 'but the code and when it was made');
  const own = async (code: unknown, email: unknown) => (await rows('select own_code($1, $2) as own', [code, email]))[0].own;
  assert.equal(await own('SITE-AB12CD', 'member@example.com'), true);
  assert.equal(await own('SITE-AB12CD', '  Member@Example.COM '), true);
  assert.equal(await own('SITE-AB12CD', 'other@example.com'), false);
  for (const [code, email] of [['SITE-NOPE00', 'member@example.com'], [null, 'member@example.com'], ['SITE-AB12CD', null], ['SITE-AB12CD', ''], ['SITE-AB12CD', '   '], [null, null]]) assert.equal(await own(code, email), false, `${code}/${email}`);
  const { db } = rows;
  await db.exec('RESET ROLE; CREATE ROLE site_other;');
  await db.exec('SET ROLE site_other');
  await assert.rejects(db.query("select own_code('SITE-AB12CD', 'member@example.com')"), /permission denied/, 'a role without EXECUTE cannot call it: not granted to PUBLIC');
});

test('run as the reader, the checkout read refuses the buyer\'s own code and still gives a friend\'s code its discount', async () => {
  const rows = await database();
  assert.deepEqual(await referralCheckout({ database: 'a_site', code: 'SITE-AB12CD', buyer_email: 'Member@Example.com', target: 'site' }, rows), {});
  const friend = await referralCheckout({ database: 'a_site', code: 'SITE-AB12CD', buyer_email: 'friend@example.com', target: 'site' }, rows);
  assert.equal(friend.checkoutCode, 'SITE-AB12CD');
  assert.equal(friend.adjustments?.length, 1);
  assert.equal(JSON.stringify(friend).includes('referrer-not-read'), false, 'the stand-in referrer never reaches the answer');
});

test('own_code answers from the real table whatever search_path the caller sets, and no error or notice text holds a stored email', async () => {
  const rows = await database();
  const { db } = rows;
  await db.exec(`RESET ROLE; CREATE SCHEMA evil; CREATE TABLE evil.referral_codes (email text, code text, made_at timestamptz);
    INSERT INTO evil.referral_codes VALUES ('attacker@example.com', 'SITE-AB12CD', now()); RESET ROLE; GRANT USAGE ON SCHEMA evil TO site_reader; SET ROLE site_reader;`);
  await db.exec('SET search_path = evil, public');
  const own = async (email: string) => (await rows('select own_code($1, $2) as own', ['SITE-AB12CD', email]))[0].own;
  assert.equal(await own('attacker@example.com'), false, 'the look-alike table is not read');
  assert.equal(await own('member@example.com'), true, 'the real table is');
  const notices: string[] = [];
  const messages: string[] = [];
  for (const sql of ['select email from referral_codes', 'select own_code($1)', 'select own_code($1, $1, $1)', "select own_code(1, 'member@example.com')"]) {
    try { await db.query(sql, ['member@example.com']); } catch (error) { messages.push(String((error as Error).message)); }
  }
  assert.ok(messages.length >= 3, 'the odd calls were refused');
  for (const text of [...messages, ...notices, ownCode.replace(/--.*$/gm, '')]) assert.equal(/member@example\.com|attacker@example\.com/.test(text), false, 'no stored email in any error or in the function');
  assert.equal(/\bRAISE\b/i.test(ownCode.replace(/--.*$/gm, '')), false, 'the function raises nothing');
});

test('a temp table named referral_codes made by the caller is not read: own_code answers from public.referral_codes', async () => {
  const rows = await database();
  const { db } = rows;
  await db.exec(`RESET ROLE; GRANT TEMPORARY ON DATABASE postgres TO site_reader; SET ROLE site_reader;
    CREATE TEMP TABLE referral_codes (email text, code text, made_at timestamptz);
    INSERT INTO pg_temp.referral_codes VALUES ('attacker@example.com', 'SITE-AB12CD', now());`);
  const own = async (email: string) => (await rows('select own_code($1, $2) as own', ['SITE-AB12CD', email]))[0].own;
  assert.equal(await own('attacker@example.com'), false, 'the temp table is not read');
  assert.equal(await own('member@example.com'), true, 'the real table is');
});
