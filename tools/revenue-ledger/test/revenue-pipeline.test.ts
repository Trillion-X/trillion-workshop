// tools/revenue-ledger/test/revenue-pipeline.test.ts
//
// The money pipeline end to end, with no key and no network: a Stripe webhook event (fixture) goes through take-payments'
// mapper and its DATA map (tools/take-payments/read-data/webhook-event-map.json) into a generic PaymentEvent, and
// projectRevenue turns those events into the RevenueView. Ported from the old package
// packages/revenue-ledger/__tests__/revenue-pipeline-e2e.test.ts (commit d926b7adb8), whose four assertions and its
// grant-twin guard are kept below.
//
// The revenue config is the default projection row the old package admitted in its things-to-store-and-run.json (its id
// is renamed to the generic checkout name, as the moved-from receipt says). It is written out here because no current
// row carries it yet: which owner holds the checkout's field mapping is an open task (verify-every-port, revenue-ledger).
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { loadWebhookEventMap, mapStripeWebhookEvent } from '../../take-payments/do-work/map-webhook-event.mjs';
import { projectRevenue } from '../read-data/project-revenue.ts';
import type { PaymentEvent, RevenueProjectionConfig } from '../read-data/revenue-types.ts';
import { fileURLToPath } from 'node:url';

const eventMap = loadWebhookEventMap(fileURLToPath(new URL('../../take-payments/read-data/webhook-event-map.json', import.meta.url)));

const checkoutConfig: RevenueProjectionConfig = {
  amount_field_path: ['amount_due_today_cents'],
  currency_field_path: ['currency'],
  recurring_field_path: ['recurring_amount_cents'],
  active_predicate: { field_path: ['subscription_status'], active_values: ['active', 'trialing'] },
  event_role_map: {
    'payment.complete': 'ignore',
    'payment.confirmed': 'add',
    'payment.refunded': 'subtract',
    'subscription.renewed': 'add',
    'no-provider.complete': 'ignore',
    'subscription.ended': 'ignore',
  },
  cohort_key_path: ['offer_id'],
};

// Real-shaped Stripe webhook events: a 50 cent founding payment, a refund of it, and a $29 subscription renewal.
const stripeEvents = [
  {
    id: 'evt_pay', type: 'payment_intent.succeeded', created: 1782086400,
    data: { object: { id: 'pi_1', amount_received: 50, currency: 'usd', metadata: { offer_id: 'founding' } } },
  },
  {
    id: 'evt_refund', type: 'charge.refunded', created: 1782090000,
    data: { object: { id: 'ch_1', amount_refunded: 50, currency: 'usd', metadata: { offer_id: 'founding' } } },
  },
  {
    id: 'evt_renew', type: 'invoice.paid', created: 1784678400,
    data: { object: {
      id: 'in_1',
      amount_paid: 2900,
      currency: 'usd',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_1', metadata: { offer_id: 'membership' } },
      },
    } },
  },
];

describe('revenue-ledger end-to-end: Stripe webhook -> mapper -> projection (real map, no key)', () => {
  const events = stripeEvents
    .map(event => mapStripeWebhookEvent(event, eventMap))
    .filter((event): event is PaymentEvent => event !== null);
  const view = projectRevenue(events, checkoutConfig);

  it('maps all three Stripe events through to generic revenue events', () => {
    expect(events).toHaveLength(3);
    expect(events.map(event => event.event_kind)).toEqual(['payment.confirmed', 'payment.refunded', 'subscription.renewed']);
  });

  it('a payment and a renewal add to gross; the refund subtracts from net', () => {
    expect(view.gross_cents).toBe(2950); // 50 (confirmed) + 2900 (renewal, role add)
    expect(view.refunds_cents).toBe(50); // the refunded charge
    expect(view.net_cents).toBe(2900); // gross - refunds
  });

  it('the subscription renewal registers as active recurring revenue (MRR basis)', () => {
    expect(view.recurring_active_cents).toBe(2900);
    expect(view.recurring_active_count).toBe(1);
    expect(events[2].attributes.provider_object_ref).toBe('sub_1');
  });

  it('revenue is attributed by offer cohort (founding nets 0 after refund; membership 2900)', () => {
    expect(view.by_cohort.founding).toMatchObject({ gross_cents: 50, net_cents: 0 });
    expect(view.by_cohort.membership).toMatchObject({ gross_cents: 2900 });
  });
});

// Guard: checkout's payment.complete is the access-grant twin dispatched by the same webhook that produces
// payment.confirmed (the revenue event). Counting both would double-count one sale; the config ignores payment.complete.
describe('revenue-ledger guard: payment.complete (grant twin) never double-counts payment.confirmed', () => {
  const sale = 'attempt_777';
  const events: PaymentEvent[] = [
    {
      event_id: `confirmed-${sale}`, occurred_at: '2026-06-29T00:00:00Z', event_kind: 'payment.confirmed',
      attributes: { amount_due_today_cents: '5000', currency: 'usd', offer_id: 'founding', checkout_attempt_id: sale },
    },
    {
      event_id: `complete-${sale}`, occurred_at: '2026-06-29T00:00:01Z', event_kind: 'payment.complete',
      attributes: { amount_due_today_cents: '5000', currency: 'usd', offer_id: 'founding', checkout_attempt_id: sale },
    },
  ];
  const view = projectRevenue(events, checkoutConfig);

  it('counts the sale once (5000), not twice: payment.complete is ignored', () => {
    expect(view.gross_cents).toBe(5000);
    expect(view.by_cohort.founding).toMatchObject({ gross_cents: 5000 });
  });
});
