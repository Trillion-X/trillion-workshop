// packages/revenue-ledger/show/__tests__/revenue-finance-surface.test.tsx
//
// Visual proof (jsdom) for the revenue finance surface across the render-state
// matrix: empty / sparse / dense. Asserts human-visible output and that NO
// internal vocabulary (cents, event_role, by_cohort) reaches the screen.
//
// Runs under the ROOT vitest config (default environment: jsdom), not the
// package's node config — invoke without --config.

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { presentRevenue } from '@/packages/revenue-ledger/show/revenue-finance-display';
import { RevenueFinanceSurface } from '@/packages/revenue-ledger/show/revenue-finance-surface';
import type { RevenueView } from '@/packages/revenue-ledger/read-data/revenue-types';

const EMPTY_VIEW: RevenueView = {
  gross_cents: 0,
  refunds_cents: 0,
  net_cents: 0,
  recurring_active_cents: 0,
  recurring_active_count: 0,
  by_cohort: {},
  by_event_role: {},
  review: { count: 0, items: [] },
};

afterEach(() => cleanup());

describe('RevenueFinanceSurface — render-state matrix', () => {
  it('empty: shows the honest empty state, not a wall of $0.00', () => {
    render(<RevenueFinanceSurface display={presentRevenue(EMPTY_VIEW)} />);
    expect(screen.getByText(/No revenue yet/i)).toBeTruthy();
    expect(screen.queryByText('Revenue')).toBeNull(); // heading not shown when empty
  });

  it('sparse: KPI labels + one offer breakdown render in human language', () => {
    const view: RevenueView = {
      ...EMPTY_VIEW,
      gross_cents: 2700,
      net_cents: 2700,
      by_cohort: { 'annual-plan': { gross_cents: 2700, net_cents: 2700, count: 1 } },
      by_event_role: { add: { total_cents: 2700, count: 1 } },
    };
    render(<RevenueFinanceSurface display={presentRevenue(view, { roleLabels: { add: 'Charges' } })} />);
    expect(screen.getByText('Revenue')).toBeTruthy();
    expect(screen.getByText('Gross revenue')).toBeTruthy();
    expect(screen.getByText('Net revenue')).toBeTruthy();
    expect(screen.getByText('By offer')).toBeTruthy();
    expect(screen.getByText('Annual Plan')).toBeTruthy(); // humanized cohort key
    expect(screen.getByText('By type')).toBeTruthy();
    expect(screen.getByText('Charges')).toBeTruthy(); // role label override
  });

  it('dense: multiple offers render highest-first; both breakdowns present', () => {
    const view: RevenueView = {
      gross_cents: 13000,
      refunds_cents: 1300,
      net_cents: 11700,
      recurring_active_cents: 2700,
      recurring_active_count: 3,
      by_cohort: {
        'starter-pass': { gross_cents: 1300, net_cents: 1300, count: 5 },
        'premium-coaching': { gross_cents: 8100, net_cents: 6800, count: 9 },
        'clinic-pass': { gross_cents: 3600, net_cents: 3600, count: 2 },
      },
      by_event_role: {
        add: { total_cents: 13000, count: 16 },
        subtract: { total_cents: 1300, count: 1 },
      },
      review: { count: 0, items: [] },
    };
    const { container } = render(<RevenueFinanceSurface display={presentRevenue(view)} />);
    expect(screen.getByText('By offer')).toBeTruthy();
    expect(screen.getByText('By type')).toBeTruthy();
    expect(screen.getByText('Premium Coaching')).toBeTruthy();
    // highest-gross offer (Premium Coaching, 8100) appears before the smallest
    const text = container.textContent ?? '';
    expect(text.indexOf('Premium Coaching')).toBeLessThan(text.indexOf('Starter Pass'));
  });

  it('never leaks internal vocabulary to the screen', () => {
    const view: RevenueView = {
      ...EMPTY_VIEW,
      gross_cents: 5000,
      net_cents: 5000,
      by_cohort: { 'annual-plan': { gross_cents: 5000, net_cents: 5000, count: 1 } },
      by_event_role: { add: { total_cents: 5000, count: 1 } },
    };
    const { container } = render(<RevenueFinanceSurface display={presentRevenue(view)} />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/cents|event_role|by_cohort|gross_cents|RevenueView|subtract\b/i);
  });
});
