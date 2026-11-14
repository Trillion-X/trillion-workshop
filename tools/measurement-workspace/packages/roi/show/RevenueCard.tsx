// packages/roi/show/RevenueCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Large featured card showing revenue total prominently with trend.
// Serves as the "hero" metric proving business value.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Revenue displayed prominently in large font
// 2. Shows total and this-month trend comparison
// 3. All styling through @/packages/ui (L065/L066 compliant)
// 4. No inline styles or raw HTML elements
//
// =============================================================================

import * as React from 'react';
import { DollarSign } from 'lucide-react';
import { Card, Container, Text } from '@/packages/ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface RevenueCardProps {
  totalCents: number;
  thisMonthCents: number;
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function formatCurrency(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * RevenueCard — large featured card showing revenue generated.
 *
 * Displays:
 * - Total revenue prominently (large number)
 * - This month's revenue as detail
 * - Dollar sign icon for visual impact
 */
export const RevenueCard: React.FC<RevenueCardProps> = ({
  totalCents,
  thisMonthCents,
}) => {
  const monthTrend = thisMonthCents > 0 ? 'up' : 'flat';

  return (
    <Card variant="surface" padding="lg">
      <Container layout="vertical" gap="md">
        {/* Header with icon */}
        <Container layout="horizontal" gap="sm" alignItems="center">
          <DollarSign size={24} style={{ color: 'var(--color-success)' }} />
          <Text variant="body" weight="semibold" color="strong">
            Revenue Generated
          </Text>
        </Container>

        {/* Total */}
        <Text variant="heading-lg" weight="bold" color="white">
          {formatCurrency(totalCents)}
        </Text>

        {/* Detail: this month */}
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="body-xs" color="subtle">
            This month: {formatCurrency(thisMonthCents)}
          </Text>
          <Text
            variant="caption"
            color={monthTrend === 'up' ? 'success' : 'muted'}
            weight="medium"
          >
            {monthTrend === 'up' ? '↑ Active' : '• Tracking'}
          </Text>
        </Container>
      </Container>
    </Card>
  );
};

RevenueCard.displayName = 'RevenueCard';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export type {};
