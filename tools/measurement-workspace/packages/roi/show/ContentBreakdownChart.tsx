// packages/roi/show/ContentBreakdownChart.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Chart showing content breakdown by platform (Instagram, Twitter, Email, Blog).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Shows item count breakdown across platforms
// 2. Uses visual bars or percentages to show distribution
// 3. All styling through @/packages/ui (L065/L066 compliant)
// 4. No raw HTML or inline styles
//
// =============================================================================

import * as React from 'react';
import { Container, Text, Card } from '@/packages/ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ContentBreakdownChartProps {
  breakdown?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * ContentBreakdownChart — displays content creation by platform.
 *
 * Shows how items are distributed across Instagram, Twitter, Email, Blog, etc.
 */
export const ContentBreakdownChart: React.FC<ContentBreakdownChartProps> = ({
  breakdown = {},
}) => {
  const total = Object.values(breakdown).reduce((sum, val) => sum + val, 0);

  if (total === 0) {
    return (
      <Card variant="surface" padding="lg">
        <Container layout="vertical" gap="md">
          <Text variant="heading-xs" weight="semibold" color="strong">
            Content by Platform
          </Text>
          <Text variant="body-xs" color="muted">
            No content created yet
          </Text>
        </Container>
      </Card>
    );
  }

  const platforms = Object.entries(breakdown)
    .sort(([, a], [, b]) => b - a);

  return (
    <Card variant="surface" padding="lg">
      <Container layout="vertical" gap="md">
        <Text variant="heading-xs" weight="semibold" color="strong">
          Content by Platform
        </Text>

        {platforms.map(([platform, count]) => {
          const percent = Math.round((count / total) * 100);
          const barWidth = Math.max(5, percent);

          return (
            <Container key={platform} layout="vertical" gap="xs">
              <Container layout="horizontal" justifyContent="between" alignItems="center">
                <Text variant="caption" color="muted" weight="medium">
                  {platform.charAt(0).toUpperCase() + platform.slice(1)}
                </Text>
                <Text variant="caption" color="strong" weight="semibold">
                  {count} ({percent}%)
                </Text>
              </Container>
              {/* Simple bar representation using text */}
              <Text variant="caption" color="muted">
                {'█'.repeat(Math.ceil(barWidth / 5))}
              </Text>
            </Container>
          );
        })}

        <Text variant="caption" color="subtle">
          Total: {total.toLocaleString()} items
        </Text>
      </Container>
    </Card>
  );
};

ContentBreakdownChart.displayName = 'ContentBreakdownChart';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export type {};
