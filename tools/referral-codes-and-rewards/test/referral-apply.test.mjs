// Tests for applying a referral code (tool:apply-a-referral-code) and for the referral event rows the referrals panel
// reads. The bakery and its accounts are made up.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyAReferralCode } from '../do-work/apply-a-referral-code.mjs';
import { referralCodeAppliedEvents, referralStateFor } from '../read-data/referral-codes.mjs';

const ADA = 'account:ada';
const BO = 'account:bo';
const CAL = 'account:cal';
const made = { kind: 'referral_code_created', subject: ADA, material: { event_type: 'referral_code_created', referral_code: 'BREAD-7K3Q', target: { on: 'product_id', value: 'product:loaf' }, occurred_at: '2026-01-01T00:00:00Z' } };
const withdrawn = { kind: 'referral_code_withdrawn', subject: ADA, material: { event_type: 'referral_code_withdrawn', referral_code: 'BREAD-7K3Q', occurred_at: '2026-01-03T00:00:00Z' } };
const AT = '2026-01-02T00:00:00Z';

test('typing a live code gives the friend\'s record and the maker\'s signup event, in any letter case', () => {
  const [applied, signup] = referralCodeAppliedEvents({ account: BO, code: ' bread-7k3q ', events: [made], occurredAt: AT });
  assert.deepEqual(applied, { kind: 'referral_code_applied', subject: BO, material: { event_type: 'referral_code_applied', referral_code: 'BREAD-7K3Q', occurred_at: AT } });
  assert.deepEqual(signup, { kind: 'referral_signup', subject: ADA, material: { event_type: 'referral_signup', referral_code: 'BREAD-7K3Q', referrer_account_id: ADA, account_id: BO, occurred_at: AT } });
});

test('the maker\'s accepted count reads the signup, and nobody else\'s count moves', () => {
  const saved = [made, ...referralCodeAppliedEvents({ account: BO, code: 'BREAD-7K3Q', events: [made], occurredAt: AT })];
  const ownEvents = account => saved.filter(event => event.subject === account);
  assert.deepEqual(referralStateFor(ADA, ownEvents(ADA)), { referral_code: 'BREAD-7K3Q', accepted_referral_count: 1 });
  assert.deepEqual(referralStateFor(BO, ownEvents(BO)), { referral_code: null, accepted_referral_count: 0 });
});

test('an unknown, withdrawn or malformed code, your own code and a second code are each refused with the reason', () => {
  assert.throws(() => referralCodeAppliedEvents({ account: BO, code: 'NOPE-0000', events: [made], occurredAt: AT }), /not a live referral code/);
  assert.throws(() => referralCodeAppliedEvents({ account: BO, code: 'BREAD-7K3Q', events: [made, withdrawn], occurredAt: AT }), /not a live referral code/);
  assert.throws(() => referralCodeAppliedEvents({ account: BO, code: 'x', events: [made], occurredAt: AT }), /4 to 32 letters/);
  assert.throws(() => referralCodeAppliedEvents({ account: ADA, code: 'BREAD-7K3Q', events: [made], occurredAt: AT }), /own referral code/);
  const first = referralCodeAppliedEvents({ account: BO, code: 'BREAD-7K3Q', events: [made], occurredAt: AT });
  assert.throws(() => referralCodeAppliedEvents({ account: BO, code: 'BREAD-7K3Q', events: [made, ...first], occurredAt: AT }), /first code stands/);
  assert.equal(referralCodeAppliedEvents({ account: CAL, code: 'BREAD-7K3Q', events: [made, ...first], occurredAt: AT }).length, 2);
});

test('the tool command takes the input as the row gives it and refuses a missing account or events', () => {
  assert.equal(applyAReferralCode({ account: BO, code: 'bread-7k3q', events: [made], occurred_at: AT }).events.length, 2);
  assert.throws(() => applyAReferralCode({ code: 'BREAD-7K3Q', events: [made] }), /needs the account/);
  assert.throws(() => applyAReferralCode({ account: BO, code: 'BREAD-7K3Q' }), /list of referral events/);
  assert.throws(() => applyAReferralCode(null), /Give \{ account, code, events \}/);
});

test('the row\'s own sample run gives the signup naming the maker, and its kit shows that answer', () => {
  const read = name => JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8'));
  const row = read('../records.json').things.find(thing => thing.payload?.id === 'tool:apply-a-referral-code').payload;
  const [sample] = row.verify;
  const answer = applyAReferralCode(sample.input);
  assert.equal(answer.events[1].material.referrer_account_id, sample.contains);
  assert.deepEqual(Object.keys(answer), row.output_schema.required);
  const kit = read('../kits/apply-a-referral-code.json');
  assert.equal(kit.worked_examples[0].hands_back, `It answered ${JSON.stringify(answer)}.`);
  assert.deepEqual(kit.worked_examples[0].mcp.input.input.input, sample.input);
});
