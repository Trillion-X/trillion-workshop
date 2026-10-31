// tools/referral-codes-and-rewards/test/referral-codes.test.mjs
// The package's own cases (codes that point at something, the account's referral state) on made-up accounts and a made-up bakery.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeReferralCode, normalizeReferralCode, referralCodeApplies, referralCodeCreatedEvent, referralCodeFor,
  referralCodesFromEvents, referralCodeWithdrawnEvent, referralStateFor, shareEarned,
} from '../read-data/referral-codes.mjs';

const ON = ['product_id', 'seller_ref'];
const made = (referrer, code, target, occurredAt) => referralCodeCreatedEvent({ referrer, code, target, occurredAt, allowedOn: ON });

test('makes readable codes from random bytes, never with I, L, O or U', () => {
  const code = makeReferralCode({ prefix: 'loaf', randomBytes: count => Uint8Array.from({ length: count }, (_, index) => index * 7) });
  assert.match(code, /^LOAF-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(normalizeReferralCode(' friend-1 '), 'FRIEND-1');
  assert.equal(normalizeReferralCode('a'), null);
  assert.match(makeReferralCode({ randomBytes: count => new Uint8Array(count) }), /^REF-000000$/);
});

test('refuses a target the caller did not allow, one missing its value, and a call with no allowed list', () => {
  assert.throws(() => made('shop:a', 'CODE-1', { on: 'customer_email', value: 'x' }, '2026-01-01T00:00:00Z'), /product_id, seller_ref/);
  assert.throws(() => made('shop:a', 'CODE-1', { on: 'product_id', value: '' }, '2026-01-01T00:00:00Z'), /on, value/);
  assert.throws(() => referralCodeCreatedEvent({ referrer: 'shop:a', code: 'CODE-1', target: { on: 'product_id', value: 'x' }, occurredAt: 'z', allowedOn: [] }), /allowed_on/);
  assert.throws(() => made('shop:a', 'a', { on: 'product_id', value: 'x' }, 'z'), /4 to 32/);
  assert.throws(() => made('', 'CODE-1', { on: 'product_id', value: 'x' }, 'z'), /account that shares/);
});

test('keeps the first account to make a code, whatever order the events arrive in', () => {
  const first = made('shop:a', 'SAME-1', { on: 'product_id', value: 'loaf' }, '2026-01-01T00:00:00Z');
  const later = made('shop:b', 'SAME-1', { on: 'product_id', value: 'bun' }, '2026-01-01T01:00:00Z');
  const held = referralCodesFromEvents([later, first]).get('SAME-1');
  assert.equal(held.referrer, 'shop:a');
  assert.equal(held.target.value, 'loaf');
});

test('applies a code only to sales whose attribute has the value it names', () => {
  const codes = referralCodesFromEvents([
    made('person:r', 'LOAF-A', { on: 'product_id', value: 'loaf' }, '2026-01-01T00:00:00Z'),
    made('person:r', 'BAKER-M', { on: 'seller_ref', value: 'baker:m' }, '2026-01-01T00:00:00Z'),
    made('person:r', 'HOUSE', { on: 'seller_ref', value: 'house' }, '2026-01-01T00:00:00Z'),
  ]);
  const sale = { product_id: 'loaf', seller_ref: 'baker:m' };
  assert.equal(referralCodeApplies(referralCodeFor(codes, 'loaf-a'), sale), true);
  assert.equal(referralCodeApplies(referralCodeFor(codes, 'BAKER-M'), sale), true);
  assert.equal(referralCodeApplies(referralCodeFor(codes, 'HOUSE'), sale), false);
  assert.equal(referralCodeApplies(referralCodeFor(codes, 'HOUSE'), { product_id: 'other', seller_ref: 'house' }), true);
  assert.equal(referralCodeApplies(referralCodeFor(codes, 'NOPE-1'), sale), false);
  assert.equal(referralCodeApplies(null, sale), false);
});

test('stops a withdrawn code, and only its own referrer can withdraw it', () => {
  const create = made('person:r', 'GONE-1', { on: 'product_id', value: 'loaf' }, '2026-01-01T00:00:00Z');
  const stranger = referralCodeWithdrawnEvent({ referrer: 'person:x', code: 'GONE-1', occurredAt: '2026-01-01T02:00:00Z' });
  assert.notEqual(referralCodeFor(referralCodesFromEvents([create, stranger]), 'GONE-1'), null);
  const owner = referralCodeWithdrawnEvent({ referrer: 'person:r', code: 'GONE-1', occurredAt: '2026-01-01T03:00:00Z' });
  const codes = referralCodesFromEvents([create, owner]);
  assert.equal(referralCodeFor(codes, 'GONE-1'), null);
  assert.equal(codes.get('GONE-1').withdrawn_at, '2026-01-01T03:00:00Z');
  assert.equal(referralCodeApplies(codes.get('GONE-1'), { product_id: 'loaf' }), false);
});

test('ignores events that are not objects or carry no code, and a created event without a target', () => {
  const codes = referralCodesFromEvents([null, 'x', { subject: 'a', material: {} }, { kind: 'referral_code_created', subject: 'a', material: { referral_code: 'GOOD-1' } }]);
  assert.equal(codes.size, 0);
});

test('the account state: no events, newest code across spellings, signups scoped to the referrer, junk ignored', () => {
  const ACCOUNT = 'account:ada';
  assert.deepEqual(referralStateFor(ACCOUNT, []), { referral_code: null, accepted_referral_count: 0 });
  assert.equal(referralStateFor(ACCOUNT, [
    { kind: 'referral.code', material: { occurred_at: '2026-07-01T00:00:00Z', referral_code: 'REF-OLD111' } },
    { material: { event_type: 'referral_code_created', occurred_at: '2026-07-10T00:00:00Z', referral_code: 'REF-NEW222' } },
  ]).referral_code, 'REF-NEW222');
  assert.equal(referralStateFor(ACCOUNT, [
    { material: { event_type: 'referral_signup', occurred_at: '2026-07-02T00:00:00Z', referrer_account_id: ACCOUNT } },
    { kind: 'referral.signup', material: { occurred_at: '2026-07-03T00:00:00Z', referrer_account_id: ACCOUNT } },
    { material: { event_type: 'referral_signup', occurred_at: '2026-07-04T00:00:00Z', referrer_account_id: 'account:someone-else' } },
  ]).accepted_referral_count, 2);
  assert.deepEqual(referralStateFor(ACCOUNT, [
    { material: undefined },
    { kind: 'plan.lifecycle', material: { event_type: 'plan_cancelled' } },
    { material: { event_type: 'referral_code_created', occurred_at: '2026-07-05T00:00:00Z', referral_code: '   ' } },
  ]), { referral_code: null, accepted_referral_count: 0 });
});

test('the share is whole cents rounded down, and a sale without a whole-number amount earns nothing', () => {
  const share = { amount_field: 'amount_cents', basis_points: 1000 };
  assert.equal(shareEarned({ amount_cents: 2000 }, share), 200);
  assert.equal(shareEarned({ amount_cents: 999 }, share), 99);
  assert.equal(shareEarned({ amount_cents: 12.5 }, share), 0);
  assert.equal(shareEarned({ amount_cents: -5 }, share), 0);
  assert.equal(shareEarned({}, share), 0);
  assert.equal(shareEarned(null, share), 0);
});
