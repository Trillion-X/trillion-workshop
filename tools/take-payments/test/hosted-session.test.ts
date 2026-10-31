// Stripe Checkout Sessions and the subscription calls around them, run against a stand-in Stripe that answers the
// built requests. Proves what is sent (the form body, the idempotency key, no key on the request), what is refused
// before anything is sent, and the installment and recovery logic.
import { describe, expect, it } from './expect.mjs';
import {
  advanceInstallment,
  cancelSubscription,
  createHostedSession,
  createSubscriptionSchedule,
  findCompletedHostedSession,
  readHostedSession,
  sessionRequestBody,
  updateSubscriptionMetadata,
} from '../do-work/hosted-session.ts';
import { encodeStripeForm } from '../do-work/stripe-form-encode.mjs';

type Sent = { method: string; url: string; headers: Record<string, string>; body?: string };

/** A stand-in Stripe: records every request and answers from a queue. */
function stripe(...replies: Array<Record<string, unknown>>) {
  const sent: Sent[] = [];
  const queue = [...replies];
  const send = async (request: Sent) => { sent.push(request); return queue.shift() ?? {}; };
  return { sent, send };
}
const fields = (request: Sent) => Object.fromEntries(new URLSearchParams(request.body ?? ''));

const recurring = {
  currency: 'usd', payment_mode: 'subscription', interval: 'month', cadence: 'month', offer_id: 'offer:box', price_option_id: 'price:box',
  client_reference_id: 'attempt-1', customer_email: 'ana@example.com', trial_days: 7, unit_count: 2, success_url: 'https://bakery.example/ok', cancel_url: 'https://bakery.example/no',
  line_items: [{ amount_cents: 1200, billing_mode: 'recurring', product_name: 'Bread box', quantity: 1 }],
};

describe('the session body', () => {
  it('a subscription carries the interval, the trial and the metadata on both the session and the subscription', () => {
    const body = fields({ method: 'POST', url: '', headers: {}, body: encodeStripeForm(sessionRequestBody(recurring)) });
    expect(body.mode).toBe('subscription');
    expect(body['line_items[0][price_data][recurring][interval]']).toBe('month');
    expect(body['line_items[0][price_data][unit_amount]']).toBe('1200');
    expect(body['subscription_data[trial_period_days]']).toBe('7');
    expect(body['metadata[offer_id]']).toBe('offer:box');
    expect(body['subscription_data[metadata][offer_id]']).toBe('offer:box');
    expect(body['subscription_data[metadata][customer_email]']).toBe('ana@example.com');
    expect(body.client_reference_id).toBe('attempt-1');
  });

  it('a one-time payment has no recurring part and no subscription data', () => {
    const body = sessionRequestBody({ ...recurring, payment_mode: 'payment', trial_days: undefined, line_items: [{ amount_cents: 900, billing_mode: 'one_time', product_name: 'Cake', quantity: 1 }] }) as Record<string, any>;
    expect(body.mode).toBe('payment');
    expect(body.line_items[0].price_data.recurring).toBeUndefined();
    expect(body.subscription_data).toBeUndefined();
  });

  it('a bounded installment plan stamps its bound into the subscription', () => {
    const body = sessionRequestBody({ ...recurring, trial_days: undefined, installment_count: 3 }) as Record<string, any>;
    expect(body.subscription_data.metadata).toMatchObject({ installment_count: '3', installments_paid: '0' });
  });

  it('a first-invoice addition is a one-time line on a subscription session', () => {
    const body = sessionRequestBody({ ...recurring, trial_days: undefined, line_items: [...recurring.line_items, { amount_cents: 3000, billing_mode: 'one_time', product_name: 'Bread box first-invoice addition', quantity: 1 }] }) as Record<string, any>;
    expect(body.line_items[0].price_data.recurring.interval).toBe('month');
    expect(body.line_items[1].price_data.recurring).toBeUndefined();
  });

  it('caller metadata is echoed, and a charge with no name or no line items is refused', () => {
    expect((sessionRequestBody({ ...recurring, metadata: { referral: 'FRIEND' } }) as Record<string, any>).metadata.referral).toBe('FRIEND');
    expect(() => sessionRequestBody({ ...recurring, line_items: [{ amount_cents: 100, quantity: 1 }] })).toThrow(/needs a name/);
    expect(() => sessionRequestBody({ ...recurring, line_items: [] })).toThrow(/At least one line item/);
  });

  it('a schedule that takes money at the door makes a payment session that keeps the card for later', () => {
    const payment_schedule = { charges: [{ amount_cents: '800', days_after_signup: 0 }, { amount_cents: '3200', days_after_signup: 7 }], repeat: { amount_cents: '4000', interval: 'month', first_days_after_signup: 37 } };
    const body = sessionRequestBody({ ...recurring, payment_schedule, line_items: [{ amount_cents: 800, billing_mode: 'one_time', product_name: 'Course', quantity: 1 }] }) as Record<string, any>;
    expect(body.mode).toBe('payment');
    expect(body.line_items[0].price_data.unit_amount).toBe(800);
    expect(body.customer_creation).toBe('always');
    expect(body.payment_intent_data).toEqual({ setup_future_usage: 'off_session' });
  });

  it('a schedule with nothing due at signup only collects the card, and one whose first money has no phase before it is refused', () => {
    const payment_schedule = { charges: [{ amount_cents: '0', days_after_signup: 0 }, { amount_cents: '5000', days_after_signup: 7 }], repeat: null };
    const body = sessionRequestBody({ ...recurring, payment_schedule }) as Record<string, any>;
    expect(body.mode).toBe('setup');
    expect(body.line_items).toBeUndefined();
    expect(() => sessionRequestBody({ ...recurring, payment_schedule: { charges: [{ amount_cents: '5000', days_after_signup: 7 }], repeat: null } })).toThrow(/first money 7 days after signup/);
  });
});

describe('creating a session', () => {
  it('sends one POST with the idempotency key and no credential, and returns the hosted address', async () => {
    const { sent, send } = stripe({ id: 'cs_1', url: 'https://pay.example/cs_1', status: 'open', mode: 'subscription' });
    const result = await createHostedSession({ session: recurring, idempotency_key: 'k-1' }, { send });
    expect(result).toMatchObject({ provider_session_id: 'cs_1', url: 'https://pay.example/cs_1' });
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(sent[0].headers['Idempotency-Key']).toBe('k-1');
    expect(JSON.stringify(sent[0])).not.toMatch(/Authorization|Bearer|sk_/);
  });

  it('refuses without an idempotency key or a session, and sends nothing', async () => {
    const { sent, send } = stripe();
    await expect(createHostedSession({ session: recurring }, { send })).rejects.toThrow(/idempotency_key is required/);
    await expect(createHostedSession({}, { send })).rejects.toThrow(/session intent is required/);
    expect(sent).toHaveLength(0);
  });

  it('refuses a reply with no hosted address rather than reporting success', async () => {
    const { send } = stripe({ id: 'cs_1' });
    await expect(createHostedSession({ session: recurring, idempotency_key: 'k' }, { send })).rejects.toThrow(/did not return a hosted checkout session url/);
  });
});

describe('reading and recovering', () => {
  it('reads the session and the subscription it made, summing the recurring amount', async () => {
    const { sent, send } = stripe(
      { id: 'cs_1', status: 'complete', payment_status: 'paid', subscription: 'sub_1', customer_details: { email: 'ana@example.com' }, metadata: { offer_id: 'offer:box', price_option_id: 'price:box', validated_amount_cents: '1200' }, created: 1790000000 },
      { items: { data: [{ price: { unit_amount: 1200 }, quantity: 1 }, { price: { unit_amount: 150 }, quantity: 3 }] }, currency: 'usd' },
    );
    const result = await readHostedSession({ provider_session_id: 'cs_1' }, { send });
    expect(sent.map(request => `${request.method} ${request.url}`)).toEqual(['GET https://api.stripe.com/v1/checkout/sessions/cs_1', 'GET https://api.stripe.com/v1/subscriptions/sub_1']);
    expect(result).toMatchObject({ payment_status: 'paid', customer_email: 'ana@example.com', offer_id: 'offer:box', recurring_amount_cents: 1650, currency: 'usd' });
    await expect(readHostedSession({}, { send })).rejects.toThrow(/provider_session_id is required/);
  });

  it('finds the completed session for one buyer and offer, paging until it does', async () => {
    const { sent, send } = stripe(
      { data: [{ id: 'cs_a', customer_email: 'other@example.com', metadata: { offer_id: 'offer:box' } }], has_more: true },
      { data: [{ id: 'cs_b', customer_details: { email: 'Ana@Example.com' }, metadata: { offer_id: 'offer:box' } }], has_more: false },
    );
    const found = await findCompletedHostedSession({ customer_email: 'ana@example.com', offer_id: 'offer:box' }, { send });
    expect(found).toMatchObject({ found: true, provider_session_id: 'cs_b', pages_read: 2 });
    expect(sent[0].url).toContain('status=complete');
    expect(sent[1].url).toContain('starting_after=cs_a');
  });

  it('with only a time boundary, answers only when exactly one session matches', async () => {
    const one = await findCompletedHostedSession({ created_after_unix: 1790000000, offer_id: 'offer:box' }, stripe({ data: [{ id: 'cs_a', metadata: { offer_id: 'offer:box' } }] }));
    expect(one.found).toBe(true);
    const two = await findCompletedHostedSession({ created_after_unix: 1790000000, offer_id: 'offer:box' }, stripe({ data: [{ id: 'cs_a', metadata: { offer_id: 'offer:box' } }, { id: 'cs_b', metadata: { offer_id: 'offer:box' } }] }));
    expect(two).toMatchObject({ found: false, ambiguous: true });
    await expect(findCompletedHostedSession({ offer_id: 'offer:box' }, stripe())).rejects.toThrow(/customer_email or created_after_unix/);
  });
});

describe('subscriptions', () => {
  it('cancels now with DELETE, or at period end with an update', async () => {
    const now = stripe({ id: 'sub_1', status: 'canceled' });
    expect(await cancelSubscription({ subscription_id: 'sub_1' }, now)).toEqual({ subscription_id: 'sub_1', status: 'canceled', cancel_at_period_end: false });
    expect(now.sent[0].method).toBe('DELETE');
    const later = stripe({ id: 'sub_1', status: 'active', cancel_at_period_end: true });
    expect((await cancelSubscription({ subscription_id: 'sub_1', at_period_end: true }, later)).cancel_at_period_end).toBe(true);
    expect(fields(later.sent[0])).toEqual({ cancel_at_period_end: 'true' });
    await expect(cancelSubscription({}, now)).rejects.toThrow(/subscription_id is required/);
  });

  it('adds only the keys given and skips the write when nothing changes', async () => {
    const same = stripe({ id: 'sub_1', metadata: { a: '1' } });
    expect((await updateSubscriptionMetadata({ subscription_id: 'sub_1', metadata: { a: '1' } }, same)).updated).toBe(false);
    expect(same.sent).toHaveLength(1);
    const changed = stripe({ id: 'sub_1', metadata: { a: '1' } }, { id: 'sub_1', metadata: { a: '1', b: '2' } });
    const result = await updateSubscriptionMetadata({ subscription_id: 'sub_1', metadata: { b: '2' } }, changed);
    expect(result).toEqual({ subscription_id: 'sub_1', metadata: { a: '1', b: '2' }, updated: true });
    expect(fields(changed.sent[1])).toEqual({ 'metadata[a]': '1', 'metadata[b]': '2' });
    expect((await updateSubscriptionMetadata({ subscription_id: 'sub_1', metadata: {} }, stripe())).updated).toBe(false);
  });

  it('creates the schedule for what comes after the door charge, with the start the caller names', async () => {
    const { sent, send } = stripe({ id: 'sched_1', status: 'not_started' });
    const payment_schedule = { charges: [{ amount_cents: '800', days_after_signup: 0 }, { amount_cents: '3200', days_after_signup: 7 }], repeat: { amount_cents: '4000', interval: 'month', first_days_after_signup: 37 } };
    const result = await createSubscriptionSchedule({ payment_schedule, customer_ref: 'cus_1', product_name: 'Course', signed_up_at_unix_seconds: 1790000000, idempotency_key: 's-1' }, { send });
    expect(result).toEqual({ schedule_id: 'sched_1', status: 'not_started', starts_at: 1790000000 + 7 * 86400 });
    expect(sent[0].url).toBe('https://api.stripe.com/v1/subscription_schedules');
    expect(sent[0].headers['Idempotency-Key']).toBe('s-1');
    await expect(createSubscriptionSchedule({ payment_schedule, product_name: 'Course', signed_up_at_unix_seconds: 1 }, { send })).rejects.toThrow(/needs the customer/);
  });
});

describe('a bounded pay-in-N plan', () => {
  it('ignores an open subscription', async () => {
    const result = await advanceInstallment({ subscription_id: 'sub_1', invoice_id: 'in_1' }, stripe({ metadata: {} }));
    expect(result).toMatchObject({ handled: false, canceled: false });
  });

  it('counts a paid installment and saves the count with the invoice it came from', async () => {
    const { sent, send } = stripe({ metadata: { installment_count: '3', installments_paid: '0' } }, {});
    const result = await advanceInstallment({ subscription_id: 'sub_1', invoice_id: 'in_1' }, { send });
    expect(result).toMatchObject({ handled: true, installments_paid: 1, installment_count: 3, canceled: false, duplicate: false });
    expect(fields(sent[1])).toEqual({ 'metadata[installments_paid]': '1', 'metadata[last_installment_invoice_id]': 'in_1' });
  });

  it('counts a replayed invoice once', async () => {
    const { sent, send } = stripe({ metadata: { installment_count: '3', installments_paid: '1', last_installment_invoice_id: 'in_1' } });
    const result = await advanceInstallment({ subscription_id: 'sub_1', invoice_id: 'in_1' }, { send });
    expect(result).toMatchObject({ duplicate: true, installments_paid: 1 });
    expect(sent).toHaveLength(1);
  });

  it('on the last installment marks the access retained, then cancels so no further invoice is made', async () => {
    const { sent, send } = stripe({ metadata: { installment_count: '3', installments_paid: '2' } }, {}, {});
    const result = await advanceInstallment({ subscription_id: 'sub_1', invoice_id: 'in_3' }, { send });
    expect(result).toMatchObject({ canceled: true, installments_paid: 3 });
    expect(sent.map(request => request.method)).toEqual(['GET', 'POST', 'DELETE']);
    expect(fields(sent[1])['metadata[entitlement_retained]']).toBe('true');
  });
});
