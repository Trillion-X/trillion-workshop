// frontends/web/src/packages/ui/progress-bar/ProgressBar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical progress bar component. Displays a filled bar at a given percentage
// with a specified color. Used in compliance dashboards, progress tracking, and
// metric displays.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Bar height always 0.375rem (6px) by default, customizable via height prop
// 2. Color specified via CSS variable string
// 3. Internal implementation only — consumers don't see the inner fill div
// 4. Flex-grow capable — stretches to fill parent container
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Card, type CardProps } from '../card/Card';

export interface ProgressBarProps extends Omit<CardProps, 'children' | 'height'> {
  /** Percentage filled (0-100) */
  percentage: number;
  /** CSS color value (e.g., 'var(--color-success)' or '#10b981') */
  color: string;
  /** Height of the bar. Default: '0.375rem' (6px) */
  height?: string;
}

/**
 * Simple progress bar. Fills left-to-right based on percentage.
 *
 * @example
 * ```tsx
 * <ProgressBar percentage={75} color="var(--color-warning)" />
 * ```
 */
const ProgressBar = React.forwardRef<HTMLDivElement, ProgressBarProps>(
  ({ percentage, color, height = '0.375rem', style, ...props }, ref) => (
    <Card
      ref={ref}
      variant="nested"
      padding="none"
      style={{
        ...style,
        height,
        overflow: 'hidden',
      }}
      {...props}
    >
      <div
        style={{
          width: `${Math.max(0, Math.min(100, percentage))}%`,
          height: '100%',
          backgroundColor: color,
        }}
      />
    </Card>
  )
);

ProgressBar.displayName = 'ProgressBar';

export { ProgressBar };
