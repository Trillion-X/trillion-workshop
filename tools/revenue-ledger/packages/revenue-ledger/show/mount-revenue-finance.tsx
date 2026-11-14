// packages/revenue-ledger/show/mount-revenue-finance.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Thin live mount for the revenue finance surface. Reads runtime rows, folds
// them into payment events + the projection config, runs the projection +
// presentation, and renders the pure `RevenueFinanceSurface`. All the logic is
// in tested pure functions (readPaymentEvents / projectRevenue / presentRevenue);
// this file is only the host-boundary glue.
//
// HONEST FALLBACK (L116/L117): if the rows carry no config or no payment events
// (e.g. the events live at a different runtime address than this surface
// subscribes to, or no charge has happened yet), the surface renders its honest
// empty state — never fabricated numbers and never a crash. Pointing the mount
// at the correct event address is composition-seam configuration.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '@/packages/ui/show/react-surface-mount';
import {
  readPaymentEvents,
  readRevenueProjectionConfig,
} from '@/packages/revenue-ledger/read-data/read-payment-events';
import { projectRevenue } from '@/packages/revenue-ledger/read-data/project-revenue';
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

export function RevenueFinanceContainer() {
  // L126: split off the raw published-records aggregate into two scoped feeds —
  // payment events self-describe via `event_kind`; the config self-describes via
  // `kind: revenue-projection-config`. Each reader consumes only its own feed.
  const paymentRows = useBitfieldData('revenue-payment-events');
  const configRows = useBitfieldData('revenue-projection-config');
  const display = React.useMemo(() => {
    const config = readRevenueProjectionConfig(configRows);
    if (!config) return presentRevenue(EMPTY_VIEW);
    return presentRevenue(projectRevenue(readPaymentEvents(paymentRows), config));
  }, [paymentRows, configRows]);
  return React.createElement(RevenueFinanceSurface, { display });
}

export function mountRevenueFinance({ el, props = {} }: ReactMaterialMountArgs) {
  return mountReactMaterial(el, React.createElement(RevenueFinanceContainer), props, 'Revenue');
}

export default mountRevenueFinance;
