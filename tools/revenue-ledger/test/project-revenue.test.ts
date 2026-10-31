// tools/revenue-ledger/test/project-revenue.test.ts
//
// Purpose: Proves the generic reducer is truly config-driven.
// Key tests:
//   1. Checkout config + real checkout field names => correct gross/net/recurring.
//   2. SECOND config with DIFFERENT field names => correct numbers, ZERO code change.
//   3. Stonehenge: empty config fields + no events => honest-zero output.
//   4. Unknown event_kind => ignored, not rejected.
//   5. Cohort grouping via cohort_key_path.

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { projectRevenue } from '../read-data/project-revenue.ts';
import type { PaymentEvent, RevenueProjectionConfig } from '../read-data/revenue-types.ts';

// ---------------------------------------------------------------------------
// Checkout config (inline unit fixture: the field names a checkout writes into a payment's metadata,
// amount_due_today_cents, recurring_amount_cents, subscription_status and offer_id, as tools/take-payments
// does)
// ---------------------------------------------------------------------------
const CHECKOUT_CONFIG: RevenueProjectionConfig = {
  amount_field_path: ['amount_due_today_cents'],
  currency_field_path: ['currency'],
  recurring_field_path: ['recurring_amount_cents'],
  active_predicate: {
    field_path: ['subscription_status'],
    active_values: ['active', 'trialing'],
  },
  event_role_map: {
    'payment.complete': 'add',
    'payment.confirmed': 'add',
    'payment.refunded': 'subtract',
    'subscription.renewed': 'add',
    'no-provider.complete': 'ignore',
  },
  cohort_key_path: ['offer_id'],
};

// Synthetic payment events using the REAL checkout attribute field names
// (amount_due_today_cents, recurring_amount_cents, subscription_status, offer_id)
const coursePayment: PaymentEvent = {
  event_id: 'payment-completed-abc123:payment',
  occurred_at: '2026-06-01T12:00:00Z',
  event_kind: 'payment.complete',
  attributes: {
    amount_due_today_cents: 2700,
    recurring_amount_cents: 0,
    currency: 'usd',
    subscription_status: 'succeeded',
    offer_id: 'course-a',
    checkout_attempt_id: 'abc123',
  },
};

const bookPayment: PaymentEvent = {
  event_id: 'payment-completed-def456:payment',
  occurred_at: '2026-06-02T14:00:00Z',
  event_kind: 'payment.complete',
  attributes: {
    amount_due_today_cents: 1300,
    recurring_amount_cents: 1300,
    currency: 'usd',
    subscription_status: 'active',
    offer_id: 'the-book',
    checkout_attempt_id: 'def456',
  },
};

const courseRefund: PaymentEvent = {
  event_id: 'refund-ghi789',
  occurred_at: '2026-06-03T09:00:00Z',
  event_kind: 'payment.refunded',
  attributes: {
    amount_due_today_cents: 2700,
    recurring_amount_cents: 0,
    currency: 'usd',
    offer_id: 'course-a',
  },
};

const renewalPayment: PaymentEvent = {
  event_id: 'renewal-jkl012',
  occurred_at: '2026-07-01T12:00:00Z',
  event_kind: 'subscription.renewed',
  attributes: {
    amount_due_today_cents: 1300,
    recurring_amount_cents: 1300,
    currency: 'usd',
    subscription_status: 'active',
    offer_id: 'the-book',
  },
};

const freeSeat: PaymentEvent = {
  event_id: 'free-mno345',
  occurred_at: '2026-06-04T10:00:00Z',
  event_kind: 'no-provider.complete',
  attributes: {
    amount_due_today_cents: 0,
    recurring_amount_cents: 0,
    currency: 'usd',
    offer_id: 'free-trial',
  },
};

// ---------------------------------------------------------------------------
// Test 1: Checkout config — gross, net, recurring
// ---------------------------------------------------------------------------
describe('projectRevenue — checkout config', () => {
  it('computes gross as sum of all add-role event amounts', () => {
    const view = projectRevenue([coursePayment, bookPayment], CHECKOUT_CONFIG);
    expect(view.gross_cents).toBe(2700 + 1300); // 4000
  });

  it('computes refunds as sum of subtract-role event amounts', () => {
    const view = projectRevenue([coursePayment, courseRefund], CHECKOUT_CONFIG);
    expect(view.refunds_cents).toBe(2700);
  });

  it('computes net as gross minus refunds', () => {
    const view = projectRevenue([coursePayment, bookPayment, courseRefund], CHECKOUT_CONFIG);
    // gross = 2700 + 1300 = 4000; refunds = 2700; net = 1300
    expect(view.net_cents).toBe(1300);
  });

  it('counts recurring_active only when active_predicate passes', () => {
    // coursePayment: recurring=0, no contribution
    // bookPayment: recurring=1300, status=active => contributes
    const view = projectRevenue([coursePayment, bookPayment], CHECKOUT_CONFIG);
    expect(view.recurring_active_cents).toBe(1300);
    expect(view.recurring_active_count).toBe(1);
  });

  it('counts renewal toward recurring active', () => {
    const view = projectRevenue([renewalPayment], CHECKOUT_CONFIG);
    expect(view.recurring_active_cents).toBe(1300);
    expect(view.recurring_active_count).toBe(1);
  });

  it('ignores no-provider.complete events in gross/net totals', () => {
    const view = projectRevenue([freeSeat, coursePayment], CHECKOUT_CONFIG);
    expect(view.gross_cents).toBe(2700);
    expect(view.refunds_cents).toBe(0);
  });

  it('groups by cohort via cohort_key_path (offer_id)', () => {
    const view = projectRevenue([coursePayment, bookPayment, courseRefund], CHECKOUT_CONFIG);
    expect(view.by_cohort['course-a']?.gross_cents).toBe(2700);
    expect(view.by_cohort['course-a']?.net_cents).toBe(0); // 2700 - 2700
    expect(view.by_cohort['the-book']?.gross_cents).toBe(1300);
    expect(view.by_cohort['the-book']?.net_cents).toBe(1300);
  });

  it('populates by_event_role for each distinct role', () => {
    const view = projectRevenue([coursePayment, courseRefund, freeSeat], CHECKOUT_CONFIG);
    expect(view.by_event_role['add']?.count).toBe(1);
    expect(view.by_event_role['subtract']?.count).toBe(1);
    expect(view.by_event_role['ignore']?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 2: GENERICITY PROOF — completely different config + different field names,
//         zero code change, same reducer produces correct numbers.
// ---------------------------------------------------------------------------
const ALT_CONFIG: RevenueProjectionConfig = {
  // Deliberately different field names (e.g. a hypothetical second provider)
  amount_field_path: ['total'],
  currency_field_path: ['iso_currency'],
  recurring_field_path: ['monthly_fee'],
  active_predicate: {
    field_path: ['state'],
    active_values: ['live'],
  },
  event_role_map: {
    'charge.succeeded': 'add',
    'charge.reversed': 'subtract',
  },
  cohort_key_path: ['plan'],
};

const altCharge1: PaymentEvent = {
  event_id: 'charge-001',
  occurred_at: '2026-06-01T00:00:00Z',
  event_kind: 'charge.succeeded',
  attributes: {
    total: 5000,
    iso_currency: 'eur',
    monthly_fee: 5000,
    state: 'live',
    plan: 'pro',
  },
};

const altCharge2: PaymentEvent = {
  event_id: 'charge-002',
  occurred_at: '2026-06-02T00:00:00Z',
  event_kind: 'charge.succeeded',
  attributes: {
    total: 2500,
    iso_currency: 'eur',
    monthly_fee: 0,
    state: 'pending',
    plan: 'starter',
  },
};

const altReversal: PaymentEvent = {
  event_id: 'reversal-003',
  occurred_at: '2026-06-03T00:00:00Z',
  event_kind: 'charge.reversed',
  attributes: {
    total: 5000,
    iso_currency: 'eur',
    monthly_fee: 0,
    plan: 'pro',
  },
};

describe('projectRevenue — genericity proof (different field names, same reducer)', () => {
  it('resolves gross from a different amount_field_path without code change', () => {
    const view = projectRevenue([altCharge1, altCharge2], ALT_CONFIG);
    expect(view.gross_cents).toBe(5000 + 2500); // 7500
  });

  it('resolves net after reversal using different subtract field names', () => {
    const view = projectRevenue([altCharge1, altReversal], ALT_CONFIG);
    expect(view.net_cents).toBe(0); // 5000 - 5000
    expect(view.refunds_cents).toBe(5000);
  });

  it('resolves recurring from a different recurring_field_path + active_predicate', () => {
    // altCharge1: monthly_fee=5000, state=live => active
    // altCharge2: monthly_fee=0, state=pending => 0 contribution
    const view = projectRevenue([altCharge1, altCharge2], ALT_CONFIG);
    expect(view.recurring_active_cents).toBe(5000);
    expect(view.recurring_active_count).toBe(1);
  });

  it('groups by a different cohort_key_path (plan) without code change', () => {
    const view = projectRevenue([altCharge1, altCharge2], ALT_CONFIG);
    expect(view.by_cohort['pro']?.gross_cents).toBe(5000);
    expect(view.by_cohort['starter']?.gross_cents).toBe(2500);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Stonehenge test — empty config / no events => honest-zero output
// ---------------------------------------------------------------------------
const EMPTY_CONFIG: RevenueProjectionConfig = {
  amount_field_path: [],
  currency_field_path: [],
  recurring_field_path: [],
  event_role_map: {},
};

describe('projectRevenue — Stonehenge test (empty config, no events)', () => {
  it('returns honest-zero view for empty event list', () => {
    const view = projectRevenue([], CHECKOUT_CONFIG);
    expect(view.gross_cents).toBe(0);
    expect(view.net_cents).toBe(0);
    expect(view.refunds_cents).toBe(0);
    expect(view.recurring_active_cents).toBe(0);
    expect(Object.keys(view.by_cohort)).toHaveLength(0);
    expect(Object.keys(view.by_event_role)).toHaveLength(0);
  });

  it('returns honest-zero view when config has empty role_map (no roles assigned)', () => {
    const view = projectRevenue([coursePayment, bookPayment], EMPTY_CONFIG);
    // All events have unknown roles => treated as ignore
    expect(view.gross_cents).toBe(0);
    expect(view.net_cents).toBe(0);
    expect(view.recurring_active_cents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Unknown event_kind is ignored (fail-safe), not rejected
// ---------------------------------------------------------------------------
describe('projectRevenue — unknown event_kind handling', () => {
  it('does not throw on unknown event_kind, ignores it in aggregates', () => {
    const unknownEvent: PaymentEvent = {
      event_id: 'mystery-event-999',
      occurred_at: '2026-06-05T00:00:00Z',
      event_kind: 'totally.unknown.future.event',
      attributes: { amount_due_today_cents: 9999 },
    };
    const view = projectRevenue([unknownEvent, coursePayment], CHECKOUT_CONFIG);
    expect(view.gross_cents).toBe(2700); // only known 'add' event contributes
    expect(view.by_event_role['ignore']?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 5: B16 review gate — unsafe money facts fail into review, not totals
// ---------------------------------------------------------------------------
describe('projectRevenue — B16 review gate for unsafe financial facts', () => {
  it('sends missing add-role amounts to review instead of silently zeroing them', () => {
    const missingAmount: PaymentEvent = {
      event_id: 'missing-amount-001',
      occurred_at: '2026-06-08T00:00:00Z',
      event_kind: 'payment.complete',
      attributes: {
        recurring_amount_cents: 1300,
        currency: 'usd',
        subscription_status: 'active',
        offer_id: 'the-book',
      },
    };
    const view = projectRevenue([missingAmount], CHECKOUT_CONFIG);
    expect(view.gross_cents).toBe(0);
    expect(view.net_cents).toBe(0);
    expect(view.recurring_active_cents).toBe(0);
    expect(view.by_event_role['add']?.count).toBe(1);
    expect(view.by_event_role['add']?.total_cents).toBe(0);
    expect(view.review).toEqual({
      count: 1,
      items: [{
        event_id: 'missing-amount-001',
        reason: 'missing-amount',
        event_kind: 'payment.complete',
        amount_raw: undefined,
      }],
    });
  });

  it('sends negative amounts to review instead of subtracting them from gross', () => {
    const negativeAmount: PaymentEvent = {
      ...coursePayment,
      event_id: 'negative-amount-001',
      attributes: {
        ...coursePayment.attributes,
        amount_due_today_cents: -2700,
      },
    };
    const view = projectRevenue([negativeAmount, bookPayment], CHECKOUT_CONFIG);
    expect(view.gross_cents).toBe(1300);
    expect(view.net_cents).toBe(1300);
    expect(view.by_event_role['add']?.count).toBe(2);
    expect(view.by_event_role['add']?.total_cents).toBe(1300);
    expect(view.review.items).toEqual([{
      event_id: 'negative-amount-001',
      reason: 'negative-amount',
      event_kind: 'payment.complete',
      amount_raw: -2700,
    }]);
    expect(view.review.count).toBe(1);
  });

  it('counts duplicate same-amount event_ids once and sends the second to review', () => {
    const duplicateCourse: PaymentEvent = {
      ...coursePayment,
      occurred_at: '2026-06-01T12:00:01Z',
      attributes: { ...coursePayment.attributes },
    };
    const view = projectRevenue([coursePayment, duplicateCourse], CHECKOUT_CONFIG);
    expect(view.gross_cents).toBe(2700);
    expect(view.net_cents).toBe(2700);
    expect(view.by_event_role['add']?.count).toBe(2);
    expect(view.by_event_role['add']?.total_cents).toBe(2700);
    expect(view.review.items).toEqual([{
      event_id: 'payment-completed-abc123:payment',
      reason: 'duplicate-event',
      event_kind: 'payment.complete',
      amount_raw: 2700,
    }]);
    expect(view.review.count).toBe(1);
  });

  it('keeps the first amount for conflicting duplicate event_ids and reviews the conflict', () => {
    const conflictingCourse: PaymentEvent = {
      ...coursePayment,
      occurred_at: '2026-06-01T12:00:01Z',
      attributes: {
        ...coursePayment.attributes,
        amount_due_today_cents: 3100,
      },
    };
    const view = projectRevenue([coursePayment, conflictingCourse], CHECKOUT_CONFIG);
    expect(view.gross_cents).toBe(2700);
    expect(view.net_cents).toBe(2700);
    expect(view.by_event_role['add']?.count).toBe(2);
    expect(view.by_event_role['add']?.total_cents).toBe(2700);
    expect(view.review.items).toEqual([{
      event_id: 'payment-completed-abc123:payment',
      reason: 'conflicting-amount',
      event_kind: 'payment.complete',
      amount_raw: 3100,
    }]);
    expect(view.review.count).toBe(1);
  });

  it('leaves clean events out of review', () => {
    const view = projectRevenue([coursePayment, bookPayment, courseRefund], CHECKOUT_CONFIG);
    expect(view.gross_cents).toBe(4000);
    expect(view.refunds_cents).toBe(2700);
    expect(view.net_cents).toBe(1300);
    expect(view.review).toEqual({ count: 0, items: [] });
  });
});

// ---------------------------------------------------------------------------
// Test 6: Trialing status counts as recurring active
// ---------------------------------------------------------------------------
describe('projectRevenue — active_predicate boundary', () => {
  it('counts trialing subscription as recurring active', () => {
    const trialingEvent: PaymentEvent = {
      event_id: 'trialing-pqr',
      occurred_at: '2026-06-06T00:00:00Z',
      event_kind: 'payment.complete',
      attributes: {
        amount_due_today_cents: 0,
        recurring_amount_cents: 2500,
        currency: 'usd',
        subscription_status: 'trialing',
        offer_id: 'annual-plan',
      },
    };
    const view = projectRevenue([trialingEvent], CHECKOUT_CONFIG);
    expect(view.recurring_active_cents).toBe(2500);
    expect(view.recurring_active_count).toBe(1);
  });

  it('does not count canceled subscription as recurring active', () => {
    const canceledEvent: PaymentEvent = {
      event_id: 'canceled-stu',
      occurred_at: '2026-06-07T00:00:00Z',
      event_kind: 'payment.complete',
      attributes: {
        amount_due_today_cents: 1300,
        recurring_amount_cents: 1300,
        currency: 'usd',
        subscription_status: 'canceled',
        offer_id: 'the-book',
      },
    };
    const view = projectRevenue([canceledEvent], CHECKOUT_CONFIG);
    expect(view.gross_cents).toBe(1300);
    expect(view.recurring_active_cents).toBe(0);
    expect(view.recurring_active_count).toBe(0);
  });
});
