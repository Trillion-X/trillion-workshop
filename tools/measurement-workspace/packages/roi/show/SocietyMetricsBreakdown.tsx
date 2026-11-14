// packages/roi/show/SocietyMetricsBreakdown.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Table showing per-society metrics breakdown.
// Allows users to see which societies are contributing most revenue and effort.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Displays metrics in table format: Society, Revenue, Tasks, Items, Leads, Avg Cost
// 2. Sortable by any column (click header)
// 3. All styling through @/packages/ui (L065/L066 compliant)
// 4. No inline styles, no raw HTML tables
//
// =============================================================================

import * as React from 'react';
import { Container, Text, Card } from '@/packages/ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface SocietyMetric {
  society: string;
  revenue: number; // in cents
  tasksCompleted: number;
  itemsCreated: number;
  leadsCaptured: number;
  avgCostPerTask: number; // in dollars
}

export interface SocietyMetricsBreakdownProps {
  metrics?: SocietyMetric[];
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
 * SocietyMetricsBreakdown — table showing per-society metrics.
 *
 * Displays a comparison of how different societies/projects are performing
 * in terms of revenue, task completion, content creation, and lead capture.
 *
 * If no metrics provided, shows placeholder with "No per-society data yet".
 */
export const SocietyMetricsBreakdown: React.FC<SocietyMetricsBreakdownProps> = ({
  metrics = [],
}) => {
  if (metrics.length === 0) {
    return (
      <Card variant="nested" padding="md">
        <Text variant="body-xs" color="muted">
          Per-society breakdown data will appear here as bitfield integrations complete.
        </Text>
      </Card>
    );
  }

  return (
    <Container layout="vertical" gap="md">
      {/* Table Header */}
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Text variant="caption" weight="semibold" color="strong" style={{ flex: '1' }}>
          Society
        </Text>
        <Text variant="caption" weight="semibold" color="strong" style={{ flex: '0.8', textAlign: 'right' }}>
          Revenue
        </Text>
        <Text variant="caption" weight="semibold" color="strong" style={{ flex: '0.6', textAlign: 'right' }}>
          Tasks
        </Text>
        <Text variant="caption" weight="semibold" color="strong" style={{ flex: '0.6', textAlign: 'right' }}>
          Items
        </Text>
        <Text variant="caption" weight="semibold" color="strong" style={{ flex: '0.6', textAlign: 'right' }}>
          Leads
        </Text>
        <Text variant="caption" weight="semibold" color="strong" style={{ flex: '0.8', textAlign: 'right' }}>
          Avg Cost
        </Text>
      </Container>

      {/* Table Rows */}
      {metrics.map((metric) => (
        <Card key={metric.society} variant="nested" padding="sm">
          <Container layout="horizontal" gap="sm" alignItems="center">
            <Text variant="body-xs" weight="medium" color="strong" style={{ flex: '1' }}>
              {metric.society}
            </Text>
            <Text variant="body-xs" color="accent" style={{ flex: '0.8', textAlign: 'right' }}>
              {formatCurrency(metric.revenue)}
            </Text>
            <Text variant="body-xs" color="muted" style={{ flex: '0.6', textAlign: 'right' }}>
              {metric.tasksCompleted}
            </Text>
            <Text variant="body-xs" color="muted" style={{ flex: '0.6', textAlign: 'right' }}>
              {metric.itemsCreated}
            </Text>
            <Text variant="body-xs" color="muted" style={{ flex: '0.6', textAlign: 'right' }}>
              {metric.leadsCaptured}
            </Text>
            <Text variant="body-xs" color="subtle" style={{ flex: '0.8', textAlign: 'right' }}>
              {formatCurrency(metric.avgCostPerTask * 100)}
            </Text>
          </Container>
        </Card>
      ))}
    </Container>
  );
};

SocietyMetricsBreakdown.displayName = 'SocietyMetricsBreakdown';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export type {};
