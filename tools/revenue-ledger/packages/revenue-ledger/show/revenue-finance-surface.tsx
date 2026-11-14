// packages/revenue-ledger/show/revenue-finance-surface.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The operator's revenue finance surface: headline KPIs + per-offer and
// per-type breakdowns, read at a glance. Pure presentational — it takes a
// finished `RevenueFinanceDisplay` and renders it; it does no data reads and no
// math (the model + projection already did all of that). Reference-grounded
// (see reference-grounded-screen-contract.md): Whop KPI tiles + payments
// breakdown, Kajabi "No Data" empty state.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure renderer — no data reads, no calculations, no durable state.
// 2. Shared ui/ primitives only — zero raw HTML, zero className (L065/L066).
// 3. Human copy only — no internal vocabulary (cents, event_role, cohort) reaches
//    the screen; labels come from the model, money is currency-formatted here.
// 4. Honest empty state when there is no revenue (no fabricated numbers, L117).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Wallet } from 'lucide-react';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { EmptyPlaceholder } from '@/packages/ui/show/empty-placeholder';
import { StatStrip } from '@/packages/ui/show/stat-strip';
import { Text } from '@/packages/ui/show/text';
import type {
  RevenueBreakdownRow,
  RevenueFinanceDisplay,
} from '@/packages/revenue-ledger/show/revenue-finance-display';

/** Format integer cents as a currency string. Presentation lives at the host
 *  boundary — the model stays pure integer cents. */
function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

/** True when there is genuinely nothing to show (all headline totals zero and no
 *  breakdown rows) — the honest empty state, never a wall of $0.00 tiles. */
function isEmpty(display: RevenueFinanceDisplay): boolean {
  return (
    display.metrics.every((m) => m.amount_cents === 0) &&
    display.cohorts.length === 0 &&
    display.roles.length === 0
  );
}

export interface RevenueFinanceSurfaceProps {
  display: RevenueFinanceDisplay;
}

export function RevenueFinanceSurface({ display }: RevenueFinanceSurfaceProps) {
  if (isEmpty(display)) {
    return (
      <EmptyPlaceholder
        icon={Wallet}
        message="No revenue yet. Totals and breakdowns appear here once payments come in."
      />
    );
  }

  const stats = display.metrics.map((metric) => ({
    label: metric.label,
    value: formatMoney(metric.amount_cents, metric.currency),
  }));

  return (
    <Container layout="vertical" gap="md">
      <Text variant="heading">Revenue</Text>
      <StatStrip stats={stats} />
      {display.cohorts.length > 0 ? (
        <BreakdownCard title="By offer" rows={display.cohorts} currency={display.currency} />
      ) : null}
      {display.roles.length > 0 ? (
        <BreakdownCard title="By type" rows={display.roles} currency={display.currency} />
      ) : null}
    </Container>
  );
}

interface BreakdownCardProps {
  title: string;
  rows: readonly RevenueBreakdownRow[];
  currency: string;
}

function BreakdownCard({ title, rows, currency }: BreakdownCardProps) {
  return (
    <Card variant="nested" padding="md">
      <Container layout="vertical" gap="sm">
        <Text variant="label" color="muted">{title}</Text>
        {rows.map((row) => (
          <Container
            key={row.id}
            layout="horizontal"
            justifyContent="between"
            alignItems="center"
            gap="sm"
          >
            <Text variant="body-xs">{row.label}</Text>
            <Text variant="body-xs" weight="medium">{formatMoney(row.gross_cents, currency)}</Text>
          </Container>
        ))}
      </Container>
    </Card>
  );
}
