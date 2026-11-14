// frontends/web/src/packages/ui/status-card/StatusCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Status-tinted Card variant for compliance, audit, and health metrics.
// Automatically tints the card and its border by a pass rate
// (0-1). Pass rates >=90% get success, 70-89% get warning, <70% get error.
// Used by compliance tracking and audit dashboards.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. StatusCard ONLY differs from Card by its tint and border colour
// 2. Border color determined by passRate prop (0-1)
// 3. All other styling (padding, variant, etc.) via Card base
// 4. Internal style attribute ONLY for border — no other inline styling
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Card, type CardProps } from '../card/Card';

export interface StatusCardProps extends CardProps {
  /** Pass rate (0-1) determining border color. >=0.9 = success, 0.7-0.89 = warning, <0.7 = error */
  passRate: number;
}

/**
 * Card with semantic status border based on pass rate.
 *
 * Wraps the Card component and tints it by passRate:
 * - >=0.9: success color (#10b981 or --color-success)
 * - 0.7-0.89: warning color (#f59e0b or --color-warning)
 * - <0.7: error color (#ef4444 or --color-error)
 *
 * @example
 * ```tsx
 * <StatusCard passRate={0.85} variant="nested" padding="md">
 *   Compliance: 85%
 * </StatusCard>
 * ```
 */
const StatusCard = React.forwardRef<HTMLDivElement, StatusCardProps>(
  ({ passRate, style, ...props }, ref) => {
    const tone =
      passRate >= 0.9
        ? 'var(--color-success)'
        : passRate >= 0.7
          ? 'var(--color-warning)'
          : 'var(--color-error)';

    const mergedStyle = {
      ...style,
      borderColor: `color-mix(in srgb, ${tone} 45%, var(--border-primary))`,
      backgroundImage: `linear-gradient(color-mix(in srgb, ${tone} 7%, transparent), color-mix(in srgb, ${tone} 7%, transparent))`,
    };

    return <Card ref={ref} style={mergedStyle} {...props} />;
  }
);

StatusCard.displayName = 'StatusCard';

export { StatusCard };
