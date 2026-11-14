// packages/roi/show/MetricCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Reusable metric card component for displaying individual ROI metrics
// (cost, time, quality, fidelity, autonomy). Combines label, numeric value,
// optional detail text, health indicator dot, and optional icon into a
// consistent, self-contained card.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Glassmorphism: bg-[var(--glass-bg-subtle)] backdrop-blur-sm border border-[var(--border-primary)] rounded-xl
// 2. Responsive sizing: adapts to container width
// 3. Health indicator: green/yellow/red status dot in top-right
// 4. Icon support: optional Lucide icon in top-left
// 5. Responsive text sizing: value text scales down on small screens
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { Card } from '@/packages/ui/show/card/Card';
import { StatusDot } from '@/packages/ui/show/status-dot/StatusDot';
import { Text } from '@/packages/ui/show/text/Text';
import { Icon } from '@/packages/ui/show/icon/Icon';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface MetricCardProps {
  /** Metric label (e.g., "Cost", "Quality", "Autonomy") */
  label: string;
  /** Primary value to display (e.g., "$2.47", "96%", "34 min") */
  value: string;
  /** Optional secondary detail text (e.g., "of $10", "78% autonomous") */
  detail?: string;
  /** Health status: green = good, yellow = warning, red = critical */
  health: 'green' | 'yellow' | 'red';
  /** Optional Lucide icon component to display in top-left */
  icon?: React.ComponentType<{ className?: string }>;
  /** Optional CSS class for custom styling */
  className?: string;
}

// ---------------------------------------------------------------------------
// HEALTH STATUS MAPPING
// ---------------------------------------------------------------------------

/**
 * Maps health status string to StatusDot variant for consistency across
 * the ROI dashboard. Provides visual feedback at a glance.
 */
function getStatusVariant(health: 'green' | 'yellow' | 'red') {
  switch (health) {
    case 'green':
      return 'success' as const;
    case 'yellow':
      return 'warning' as const;
    case 'red':
      return 'error' as const;
  }
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Individual metric card for ROI dashboard.
 *
 * Displays a single ROI metric with its current value, health indicator,
 * optional icon, and optional detail text. Combines into a responsive grid
 * layout when placed alongside other MetricCards in ROIDashboard.
 */
export const MetricCard = React.forwardRef<HTMLDivElement, MetricCardProps>(
  ({ label, value, detail, health, icon: LucideIconComponent, className, ...props }, ref) => (
    <Card
      ref={ref}
      variant="nested"
      padding="md"
      className={`flex flex-col gap-3 ${className || ''}`}
      {...props}
    >
      {/* Header: Icon + Label + Health Dot */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {LucideIconComponent && (
            <Icon icon={LucideIconComponent} size="sm" color="subtle" />
          )}
          <Text variant="label" weight="medium" className="uppercase tracking-wider">
            {label}
          </Text>
        </div>
        <StatusDot status={getStatusVariant(health)} size="sm" />
      </div>

      {/* Content: Value + Detail */}
      <div className="flex flex-col gap-1">

        {/* Value — large, prominent */}
        <Text variant="heading" weight="bold" className="text-lg sm:text-2xl">
          {value}
        </Text>

        {/* Optional detail text */}
        {detail && (
          <Text variant="body-xs" color="subtle">
            {detail}
          </Text>
        )}
      </div>
    </Card>
  )
);

MetricCard.displayName = 'MetricCard';
