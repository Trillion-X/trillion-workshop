// tools/take-payments/test/billing-guide.test.ts
//
// The billing screen's description (packages/billing/read-data/billing-guide.ts): a free person sees their plan and the
// plans to join, each with a Join that names its offer and price option; a paid person sees plan, card, receipts, other
// plans and cancel, each change one press to a step of Stripe's billing page; a plan ending soon says when and offers no
// second cancel; the card is brand, last four and expiry only; and every word is the words file's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_FLOW, JOIN_PLAN, billingGuide, billingWords as words, type BillingPage } from '../packages/billing/read-data/billing-guide.ts';

const FREE = { id: 'free', label: 'Free', paid: false, price_text: null };
const MEMBERSHIP = { id: 'offer:membership', label: 'Membership', paid: true, price_text: '$99 /month' };
const OTHER = { id: 'offer:membership', label: 'Membership', price_text: '$99 /month', price_option_id: 'price:membership:monthly' };

const PAGE: BillingPage = {
  subscription_id: 'sub_sample0001', status: 'active', cancel_at_period_end: false,
  renews_at: '2026-12-24T12:00:00Z', ends_at: null,
  plan: { label: 'Membership', amount_cents: 9900, currency: 'usd', interval: 'month', quantity: 1 },
  card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2028 },
  receipts: [{ id: 'in_1', number: 'A-0001', created_at: '2026-11-24T12:00:00Z', status: 'paid', amount_paid_cents: 9900, currency: 'usd', receipt_url: 'https://invoice.stripe.com/i/sample' }],
};

const section = (description: ReturnType<typeof billingGuide>, id: string) => description.sections.find(part => part.id === id);

test('a free person sees the free plan and each plan to join, with a Join naming its offer and price option', () => {
  const guide = billingGuide({ plan: FREE, otherPlans: [OTHER], page: null, canJoin: true });
  assert.deepEqual(guide.sections.map(part => part.id), ['plan', 'plans']);
  assert.equal(guide.lead, words.lead_free);
  assert.equal(section(guide, 'plan')?.rows?.[0].title, 'Free');
  assert.equal(section(guide, 'plans')?.heading, words.plans_heading_free);
  const join = section(guide, 'plans')?.rows?.[0].actions?.[0];
  assert.equal(join?.label, words.join);
  assert.equal(join?.tone, 'primary');
  assert.deepEqual(join?.send, { path: JOIN_PLAN, body: { offer_id: 'offer:membership', price_option_id: 'price:membership:monthly' } });
});

test('a plan held without a purchase of their own is included, with nothing to manage', () => {
  const guide = billingGuide({ plan: MEMBERSHIP, otherPlans: [OTHER], page: null, canJoin: true });
  assert.equal(guide.lead, words.lead_included);
  const plan = section(guide, 'plan')?.rows?.[0];
  assert.deepEqual([plan?.title, plan?.detail, plan?.status?.label, plan?.actions], ['Membership', words.included_detail, words.status_active, undefined]);
  assert.equal(section(guide, 'plans')?.heading, words.plans_heading);
});

test('a plan whose price the buyer may choose joins at its listed amount', () => {
  const join = section(billingGuide({ plan: FREE, otherPlans: [{ ...OTHER, selected_amount_cents: 9900 }], page: null, canJoin: true }), 'plans')?.rows?.[0].actions?.[0];
  assert.deepEqual(join?.send?.body, { offer_id: 'offer:membership', price_option_id: 'price:membership:monthly', selected_amount_cents: 9900 });
});

test('without a checkout, or without a price option, a plan shows no Join', () => {
  assert.equal(section(billingGuide({ plan: FREE, otherPlans: [OTHER], page: null, canJoin: false }), 'plans')?.rows?.[0].actions, undefined);
  const { price_option_id: _gone, ...noOption } = OTHER;
  assert.equal(section(billingGuide({ plan: FREE, otherPlans: [noOption], page: null, canJoin: true }), 'plans')?.rows?.[0].actions, undefined);
});

test('a paid person sees plan, card, receipts and cancel, each change one press to a Stripe billing step', () => {
  const guide = billingGuide({ plan: MEMBERSHIP, otherPlans: [], page: PAGE, canJoin: true });
  assert.deepEqual(guide.sections.map(part => part.id), ['plan', 'card', 'receipts', 'cancel']);
  const plan = section(guide, 'plan')?.rows?.[0];
  assert.equal(plan?.title, 'Membership');
  assert.equal(plan?.detail, '$99 a month · Renews on Dec 24, 2026');
  assert.deepEqual(plan?.status, { label: words.status_active, tone: 'good' });
  assert.deepEqual(plan?.actions?.[0].send, { path: BILLING_FLOW, body: { flow: 'subscription_update' } });
  assert.deepEqual(section(guide, 'card')?.rows?.[0].actions?.[0].send, { path: BILLING_FLOW, body: { flow: 'payment_method_update' } });
  const cancel = section(guide, 'cancel');
  assert.equal(cancel?.actions?.[0].tone, 'danger');
  assert.equal(cancel?.actions?.[0].send?.confirm, undefined, 'Stripe asks; the screen adds no second question');
  assert.deepEqual(cancel?.actions?.[0].send?.body, { flow: 'subscription_cancel' });
  assert.match(cancel?.body ?? '', /Dec 24, 2026/);
});

test('the card is brand, last four and expiry only, and a receipt links to its own page', () => {
  const guide = billingGuide({ plan: MEMBERSHIP, otherPlans: [], page: PAGE, canJoin: true });
  const card = section(guide, 'card')?.rows?.[0];
  assert.equal(card?.title, 'Visa •••• 4242');
  assert.equal(card?.detail, 'Expires 04/28');
  const receipt = section(guide, 'receipts')?.rows?.[0];
  assert.equal(receipt?.title, 'Nov 24, 2026');
  assert.equal(receipt?.detail, '$99 · No. A-0001');
  assert.deepEqual(receipt?.status, { label: words.receipt_paid, tone: 'good' });
  assert.equal(receipt?.actions?.[0].href, 'https://invoice.stripe.com/i/sample');
});

test('a plan ending at its period end says when, and offers no second cancel', () => {
  const guide = billingGuide({ plan: MEMBERSHIP, otherPlans: [], page: { ...PAGE, cancel_at_period_end: true, ends_at: '2026-12-24T12:00:00Z' }, canJoin: true });
  assert.equal(section(guide, 'cancel'), undefined);
  const plan = section(guide, 'plan')?.rows?.[0];
  assert.equal(plan?.detail, '$99 a month · Ends on Dec 24, 2026');
  assert.deepEqual(plan?.status, { label: 'Ends Dec 24, 2026', tone: 'attention' });
});

test('a purchase with no card asks for one, and one with no receipts draws no receipts part', () => {
  const guide = billingGuide({ plan: MEMBERSHIP, otherPlans: [], page: { ...PAGE, card: null, receipts: [] }, canJoin: true });
  assert.equal(section(guide, 'receipts'), undefined);
  const card = section(guide, 'card')?.rows?.[0];
  assert.equal(card?.title, words.no_card);
  assert.equal(card?.actions?.[0].tone, 'primary');
});

test('a payment that failed says payment due', () => {
  const plan = section(billingGuide({ plan: MEMBERSHIP, otherPlans: [], page: { ...PAGE, status: 'past_due' }, canJoin: true }), 'plan')?.rows?.[0];
  assert.deepEqual(plan?.status, { label: words.status_past_due, tone: 'bad' });
});
