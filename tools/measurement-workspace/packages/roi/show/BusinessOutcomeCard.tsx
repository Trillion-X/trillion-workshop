// packages/roi/show/BusinessOutcomeCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Card component displaying a single business outcome metric.
// Shows metric label, value, trend indicator, and unit.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Displays outcome label, value with unit, and trend (up/down/flat)
// 2. Color coded: green for positive, neutral for flat, uses ui/ components
// 3. All styling through @/packages/ui (L065/L066 compliant)
// 4. No inline styles or raw HTML elements
//
// =============================================================================

import * as React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { Card, Container, Text } from '@/packages/ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface BusinessOutcomeCardProps {
  label: string;
  value: number | string;
  unit: string;
  trend?: 'up' | 'down' | 'flat';
  trendPercent?: number;
  detail?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * BusinessOutcomeCard — displays a single business outcome metric.
 *
 * Examples:
 * - Tasks Completed: 127 tasks
 * - Revenue Generated: $12,540
 * - Content Reach: 45.2K impressions
 * - Lead Conversion: 12.5%
 */
export const BusinessOutcomeCard: React.FC<BusinessOutcomeCardProps> = ({
  label,
  value,
  unit,
  trend,
  trendPercent,
  detail,
}) => {
  const trendColor = trend === 'up' ? 'success' : trend === 'down' ? 'error' : 'muted';
  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;

  return (
    <Card variant="nested" padding="md">
      <Container layout="vertical" gap="sm">
        {/* Label */}
        <Text variant="caption" color="muted">
          {label}
        </Text>

        {/* Value + Trend */}
        <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm">
          <Container layout="vertical" gap="xs">
            <Text variant="heading-sm" weight="bold" color="strong">
              {typeof value === 'number' ? value.toLocaleString() : value} {unit}
            </Text>
            {detail && <Text variant="caption" color="subtle">{detail}</Text>}
          </Container>

          {trend && (
            <Container layout="horizontal" gap="xs" alignItems="center">
              <TrendIcon size={16} style={{ color: `var(--color-${trendColor === 'success' ? 'success' : trendColor === 'error' ? 'error' : 'warning'})` }} />
              {trendPercent !== undefined && (
                <Text variant="caption" color={trendColor as any}>
                  {trend === 'up' ? '+' : trend === 'down' ? '-' : ''}{Math.abs(trendPercent)}%
                </Text>
              )}
            </Container>
          )}
        </Container>
      </Container>
    </Card>
  );
};

BusinessOutcomeCard.displayName = 'BusinessOutcomeCard';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export type {};
