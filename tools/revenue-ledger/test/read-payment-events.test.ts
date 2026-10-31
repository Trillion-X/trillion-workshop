// tools/revenue-ledger/test/read-payment-events.test.ts
//
// Proves the rows -> typed input read boundary: readPaymentEvents folds opaque
// runtime rows into PaymentEvent[], readRevenueProjectionConfig resolves the
// config row, and the full chain (rows -> events -> projectRevenue ->
// the RevenueView) gives the finished totals. (The finance screen that drew them, presentRevenue, stayed
// behind as a screen; this chain asserts on the RevenueView it was drawn from.)

import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import {
  readPaymentEvents,
  readRevenueProjectionConfig,
} from '../read-data/read-payment-events.ts';
import { projectRevenue } from '../read-data/project-revenue.ts';
import type { RevenueProjectionConfig } from '../read-data/revenue-types.ts';

const CONFIG: RevenueProjectionConfig = {
  amount_field_path: ['amount_due_today_cents'],
  currency_field_path: ['currency'],
  recurring_field_path: ['recurring_amount_cents'],
  event_role_map: { 'payment.complete': 'add', 'payment.refunded': 'subtract' },
  cohort_key_path: ['offer_id'],
};

function row(payload: unknown) {
  return { payload };
}

describe('readPaymentEvents', () => {
  it('keeps only self-describing payment events (event_kind + event_id)', () => {
    const rows = [
      row({ event_id: 'e1', event_kind: 'payment.complete', occurred_at: '2026-06-20', attributes: { amount_due_today_cents: 2700, currency: 'USD', offer_id: 'annual-plan' } }),
      row({ kind: 'revenue-projection-config', id: 'cfg' }), // not an event
      row({ some: 'unrelated-record' }),
    ];
    const events = readPaymentEvents(rows);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_id: 'e1', event_kind: 'payment.complete' });
    expect(events[0].attributes.amount_due_today_cents).toBe(2700);
  });

  it('falls back to the flat payload as attributes when no nested attributes', () => {
    const events = readPaymentEvents([
      row({ event_id: 'e2', event_kind: 'payment.complete', amount_due_today_cents: 5000, currency: 'USD' }),
    ]);
    expect(events[0].attributes.amount_due_today_cents).toBe(5000);
    // envelope keys are stripped from the fallback attributes
    expect(events[0].attributes.event_kind).toBeUndefined();
  });

  it('handles bare objects and non-array input safely', () => {
    expect(readPaymentEvents(null)).toEqual([]);
    expect(readPaymentEvents('nope')).toEqual([]);
    expect(readPaymentEvents([{ event_id: 'e3', event_kind: 'payment.refunded' }])).toHaveLength(1);
  });
});

describe('readRevenueProjectionConfig', () => {
  it('resolves the first revenue-projection-config payload', () => {
    const cfg = readRevenueProjectionConfig([
      row({ event_id: 'e1', event_kind: 'payment.complete' }),
      row({ kind: 'revenue-projection-config', amount_field_path: ['x'] }),
    ]);
    expect(cfg).toBeTruthy();
    expect(cfg?.amount_field_path).toEqual(['x']);
  });

  it('returns undefined when absent (caller shows honest empty state)', () => {
    expect(readRevenueProjectionConfig([row({ event_id: 'e1', event_kind: 'payment.complete' })])).toBeUndefined();
  });
});

describe('full chain: rows -> events -> projectRevenue', () => {
  it('produces the finished totals from raw rows', () => {
    const rows = [
      row({ event_id: 'e1', event_kind: 'payment.complete', attributes: { amount_due_today_cents: 2700, currency: 'USD', offer_id: 'annual-plan' } }),
      row({ event_id: 'e2', event_kind: 'payment.complete', attributes: { amount_due_today_cents: 8100, currency: 'USD', offer_id: 'premium-coaching' } }),
      row({ event_id: 'e3', event_kind: 'payment.refunded', attributes: { amount_due_today_cents: 1300, currency: 'USD', offer_id: 'annual-plan' } }),
    ];
    const view = projectRevenue(readPaymentEvents(rows), CONFIG);
    expect(view.gross_cents).toBe(10_800); // 2700 + 8100
    expect(view.refunds_cents).toBe(1_300);
    // the higher-gross offer has the larger cohort
    expect(view.by_cohort['premium-coaching'].gross_cents).toBeGreaterThan(view.by_cohort['annual-plan'].gross_cents);
  });
});
