// The referral part of a checkout, read from a pursuit's own rows in PGlite: a live code of someone else gives the friend's
// discount as the checkout takes it and the code for the session's metadata; a malformed, unknown or own code, or none, gives
// nothing; a rule the referral rules refuse, or no target row, stops the read. Synthetic people and codes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { referralCheckout } from '../reads/referral-checkout.ts';

const FRIEND_RULE = {
  label: 'Friend: $25 off the first month', state: 'active', earner: 'friend', reward: 'discount', code_points_at: 'offer_id',
  code_points_at_value: 'offer:membership', offer_ids: ['offer:membership'], amount_cents: 2500, currency: 'usd', duration: 'once',
};
const REFERRER_RULE = {
  label: 'Referrer: $25 credit', state: 'active', earner: 'referrer', reward: 'credit', code_points_at: 'offer_id',
  code_points_at_value: 'offer:membership', offer_ids: ['offer:membership'], amount_cents: 2500, currency: 'usd',
};

async function database(rules = [FRIEND_RULE, REFERRER_RULE], target = true) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE referral_codes (email text PRIMARY KEY, code text UNIQUE NOT NULL, made_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE referral_reward_rules (id text PRIMARY KEY, value jsonb NOT NULL);
    CREATE TABLE referral_code_target (name text PRIMARY KEY, target_on text NOT NULL, target_value text NOT NULL);
    INSERT INTO referral_codes (email, code) VALUES ('member@example.com', 'SITE-AB12CD');
  `);
  for (const [i, rule] of rules.entries()) await db.query('INSERT INTO referral_reward_rules (id, value) VALUES ($1, $2)', [`referral-reward-rule:${i}`, JSON.stringify(rule)]);
  if (target) await db.query("INSERT INTO referral_code_target (name, target_on, target_value) VALUES ('site', 'offer_id', 'offer:membership')");
  return async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Record<string, unknown>[];
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
