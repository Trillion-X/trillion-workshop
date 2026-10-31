// packages/stripe-payment-provider/tests/connect-payees.test.ts
//
// No-key proof of paying payees through Stripe Connect: the operation rows build the exact requests (a payee account
// by controller properties, onboarding, a balance read that acts for the payee), a destination checkout keeps the
// platform fee back and sends the rest to the payee, and the payee webhooks map through the real event-map DATA.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from './expect.mjs';
// eslint-disable-next-line import/extensions
import { buildStripeHttpRequest } from '../do-work/build-stripe-http-request.mjs';
// eslint-disable-next-line import/extensions
import { destinationCheckoutSubject, feeCents, onboardingLinkSubject, payeeAccountSubject, payeeReadiness, shareTransferSubject } from '../do-work/connect-payees.mjs';
// eslint-disable-next-line import/extensions
import { mapStripeWebhookEvent } from '../do-work/map-stripe-webhook-event.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENT_MAP = JSON.parse(readFileSync(join(HERE, '../read-data/stripe-webhook-event-map.json'), 'utf8'));
const PAYEE_EVENT_MAP = JSON.parse(readFileSync(join(HERE, '../read-data/stripe-payee-event-map.json'), 'utf8'));
const SETTINGS = {
  country: 'US',
  controller: { fees: { payer: 'application' }, losses: { payments: 'application' }, stripe_dashboard: { type: 'express' }, requirement_collection: 'stripe' },
  capabilities: ['transfers'],
};

describe('payee operation rows', () => {
  it('creates a payee account by controller properties on the v1 accounts address', () => {
    const request = buildStripeHttpRequest({ operation_id: 'operation:create-connected-account', input_facts: { operation_subject: payeeAccountSubject({ settings: SETTINGS, owner: 'market', payee_ref: 'maker:1' }) } });
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.stripe.com/v1/accounts');
    expect(request.body).toContain('controller%5Bfees%5D%5Bpayer%5D=application');
    expect(request.body).toContain('capabilities%5Btransfers%5D%5Brequested%5D=true');
    expect(request.body).toContain('metadata%5Bpayee_ref%5D=maker%3A1');
    expect(request.headers['Stripe-Account']).toBeUndefined();
  });

  it('reads a payee balance by acting for that account, and the platform balance when no account is named', () => {
    const forPayee = buildStripeHttpRequest({ operation_id: 'operation:read-balance', input_facts: { acting_account: 'acct_payee' } });
    expect(forPayee).toMatchObject({ method: 'GET', url: 'https://api.stripe.com/v1/balance' });
    expect(forPayee.headers['Stripe-Account']).toBe('acct_payee');
    expect(buildStripeHttpRequest({ operation_id: 'operation:read-balance', input_facts: {} }).headers['Stripe-Account']).toBeUndefined();
    const payouts = buildStripeHttpRequest({ operation_id: 'operation:find-payouts', input_facts: { acting_account: 'acct_payee', operation_subject: { limit: 5 } } });
    expect(payouts.url).toBe('https://api.stripe.com/v1/payouts?limit=5');
    expect(payouts.headers['Stripe-Account']).toBe('acct_payee');
  });

  it('refuses an acting account that is not an id rather than sending it', () => {
    expect(() => buildStripeHttpRequest({ operation_id: 'operation:read-balance', input_facts: { acting_account: { id: 'acct_x' } } })).toThrow(/acting_account must be an account id/);
  });

  it('opens Stripe-hosted onboarding and a dashboard sign-in for one payee', () => {
    const link = buildStripeHttpRequest({ operation_id: 'operation:create-account-link', input_facts: { operation_subject: onboardingLinkSubject({ account: 'acct_payee', refresh_url: 'https://x/again', return_url: 'https://x/back' }) } });
    expect(link.url).toBe('https://api.stripe.com/v1/account_links');
    expect(link.body).toContain('type=account_onboarding');
    expect(buildStripeHttpRequest({ operation_id: 'operation:create-login-link', input_facts: { provider_object_ref: 'acct_payee' } }).url).toBe('https://api.stripe.com/v1/accounts/acct_payee/login_links');
  });
});

describe('destination checkout', () => {
  const offer = { id: 'offer:tool-a', label: 'Tool A' };
  const once = { id: 'option:tool-a-pack', label: '100 runs', amount_cents: 2000, currency: 'USD' };
  const monthly = { id: 'option:tool-a-monthly', label: 'Monthly', amount_cents: 900, currency: 'usd', payment_timing: 'subscription', interval: 'month' };
  const fee = { percent: 20 };

  it('pays the payee once and keeps the platform fee back', () => {
    const subject = destinationCheckoutSubject({ offer, option: once, payee_account: 'acct_maker', fee, payer_ref: 'person-1', success_url: 'https://x/ok', cancel_url: 'https://x/no' });
    expect(subject.mode).toBe('payment');
    expect(subject.payment_intent_data).toMatchObject({ application_fee_amount: 400, transfer_data: { destination: 'acct_maker' } });
    expect(subject.metadata).toMatchObject({ offer_id: 'offer:tool-a', payee_account: 'acct_maker', platform_fee_cents: '400', payer_ref: 'person-1' });
    expect(subject.line_items[0].price_data).toMatchObject({ currency: 'usd', unit_amount: 2000 });
    expect(subject.subscription_data).toBeUndefined();
  });

  it('makes a subscription whose every invoice pays the payee less the fee percent', () => {
    const subject = destinationCheckoutSubject({ offer, option: monthly, payee_account: 'acct_maker', fee, payer_ref: 'person-1', success_url: 'https://x/ok', cancel_url: 'https://x/no' });
    expect(subject.mode).toBe('subscription');
    expect(subject.subscription_data).toMatchObject({ application_fee_percent: 20, transfer_data: { destination: 'acct_maker' }, metadata: { payer_ref: 'person-1' } });
    expect(subject.line_items[0].price_data.recurring).toEqual({ interval: 'month' });
    expect(subject.payment_intent_data).toBeUndefined();
  });

  it('pays the platform when there is no payee, with no fee fields', () => {
    const subject = destinationCheckoutSubject({ offer, option: once, payer_ref: 'person-1', success_url: 'https://x/ok', cancel_url: 'https://x/no' });
    expect(subject.payment_intent_data).toEqual({ metadata: expect.objectContaining({ offer_id: 'offer:tool-a' }) });
    expect(subject.metadata.platform_fee_cents).toBeUndefined();
  });

  it('refuses a payee payment without a fee row, a free option and a subscription without an interval', () => {
    expect(() => destinationCheckoutSubject({ offer, option: once, payee_account: 'acct_maker', payer_ref: 'p' })).toThrow(/fee row/);
    expect(() => destinationCheckoutSubject({ offer, option: { ...once, amount_cents: 0 }, payer_ref: 'p' })).toThrow(/positive amount_cents/);
    expect(() => destinationCheckoutSubject({ offer, option: { ...monthly, interval: 'fortnight' }, payer_ref: 'p' })).toThrow(/interval/);
  });

  it('computes the fee in whole cents and never above the amount', () => {
    expect(feeCents({ amount_cents: 999, fee: { percent: 15 } })).toBe(150);
    expect(feeCents({ amount_cents: 50, fee: { percent: 100 } })).toBe(50);
    expect(() => feeCents({ amount_cents: 50, fee: { percent: 120 } })).toThrow(/between 0 and 100/);
  });

  it('pays a share on to another payee tied to its source payment', () => {
    expect(shareTransferSubject({ amount_cents: 40, currency: 'USD', destination: 'acct_ref', source_transaction: 'ch_1' })).toEqual({ amount: 40, currency: 'usd', destination: 'acct_ref', source_transaction: 'ch_1', metadata: {} });
    expect(() => shareTransferSubject({ amount_cents: 0, currency: 'usd', destination: 'acct_ref' })).toThrow(/positive/);
  });
});

describe('payee readiness and payee events', () => {
  it('says a payee can be paid only when the transfers capability is active', () => {
    expect(payeeReadiness({ capabilities: { transfers: 'inactive' }, details_submitted: false, requirements: { currently_due: ['tos_acceptance.date'] } })).toEqual({ can_be_paid: false, onboarding_done: false, payouts_enabled: false, due: ['tos_acceptance.date'] });
    expect(payeeReadiness({ capabilities: { transfers: 'active' }, details_submitted: true, payouts_enabled: true, requirements: { currently_due: [] } }).can_be_paid).toBe(true);
  });
  it('maps a payee account update and a payout through the payee event-map DATA, which the revenue map never emits', () => {
    const updated = mapStripeWebhookEvent({ id: 'evt_1', type: 'account.updated', created: 1790000000, account: 'acct_payee', data: { object: { id: 'acct_payee', details_submitted: true, payouts_enabled: true, capabilities: { transfers: 'active' }, metadata: { payee_ref: 'maker:1' }, requirements: { currently_due: [] } } } }, PAYEE_EVENT_MAP);
    expect(updated).toMatchObject({ event_kind: 'payee.account-updated', attributes: { provider_object_ref: 'acct_payee', payee_ref: 'maker:1', transfers_capability: 'active', details_submitted: true } });
    const paid = mapStripeWebhookEvent({ id: 'evt_2', type: 'payout.paid', created: 1790000000, account: 'acct_payee', data: { object: { id: 'po_1', amount: 480, currency: 'usd', arrival_date: 1790086400 } } }, PAYEE_EVENT_MAP);
    expect(paid).toMatchObject({ event_kind: 'payee.payout-paid', attributes: { payee_account: 'acct_payee', amount_cents: 480 } });
    expect(mapStripeWebhookEvent({ id: 'evt_4', type: 'account.updated', created: 1790000000, data: { object: { id: 'acct_payee' } } }, EVENT_MAP)).toBeNull();
  });

  it('carries the payee, fee and referral of a destination checkout into the payment event', () => {
    const event = mapStripeWebhookEvent({ id: 'evt_3', type: 'checkout.session.completed', created: 1790000000, data: { object: { id: 'cs_1', amount_total: 2000, currency: 'usd', client_reference_id: 'person-1', payment_status: 'paid', metadata: { offer_id: 'offer:tool-a', payee_account: 'acct_maker', payee_ref: 'maker:1', platform_fee_cents: '400', referral_code: 'FRIEND' } } } }, EVENT_MAP);
    expect(event?.attributes).toMatchObject({ payee_account: 'acct_maker', payee_ref: 'maker:1', platform_fee_cents: '400', referral_code: 'FRIEND', checkout_attempt_id: 'person-1' });
  });
});
