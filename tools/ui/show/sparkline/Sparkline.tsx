// frontends/web/src/packages/ui/sparkline/Sparkline.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Sparkline component for trend visualization. Renders vertical bars
// representing data points over time, useful for quick trend analysis
// without external charting libraries.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. PURE COMPONENT: Minimal styling, focuses on data visualization
// 2. AUTO-SCALING: Heights calculated relative to max value in dataset
// 3. COLOR CODING: Variants map to success/warning/error based on value ranges
// 4. ACCESSIBILITY: title attributes on bars for hover tooltips
//
// =============================================================================

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

export const sparklineVariants = cva('flex items-end gap-1 w-full', {
  variants: {
    height: {
      xs: 'h-8',
      sm: 'h-12',
      md: 'h-16',
      lg: 'h-20',
    },
  },
  defaultVariants: {
    height: 'md',
  },
});

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface SparklinePoint {
  value: number;
  label?: string;
  getVariant?: (value: number, max: number) => 'success' | 'warning' | 'error' | 'info' | 'neutral';
}

export interface SparklineProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof sparklineVariants> {
  points: SparklinePoint[];
  getVariant?: (value: number, max: number) => 'success' | 'warning' | 'error' | 'info' | 'neutral';
}

// ---------------------------------------------------------------------------
// BAR SUBCOMPONENT
// ---------------------------------------------------------------------------

const sparklineBarVariants = cva('rounded-sm transition-colors flex-1', {
  variants: {
    variant: {
      success: 'bg-status-success/60 hover:bg-status-success/80',
      warning: 'bg-status-warning/60 hover:bg-status-warning/80',
      error: 'bg-status-error/40 hover:bg-status-error/60',
      info: 'bg-status-info/60 hover:bg-status-info/80',
      neutral: 'bg-[var(--glass-bg-active)] hover:bg-[var(--glass-bg-subtle)]0',
    },
  },
  defaultVariants: {
    variant: 'neutral',
  },
});

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Sparkline component for trend visualization.
 *
 * Renders vertical bars scaled to represent data points. Each bar's height
 * is proportional to its value relative to the maximum value in the dataset.
 *
 * @example
 * ```tsx
 * <Sparkline
 *   points={[
 *     { value: 85, label: 'Week 1' },
 *     { value: 92, label: 'Week 2' },
 *     { value: 78, label: 'Week 3' },
 *   ]}
 *   height="md"
 *   getVariant={(value) => value >= 90 ? 'success' : value >= 70 ? 'warning' : 'error'}
 * />
 * ```
 */
export const Sparkline = React.forwardRef<HTMLDivElement, SparklineProps>(
  ({ className, height, points, getVariant, ...props }, ref) => {
    const maxValue = Math.max(...points.map((p) => p.value), 1);

    return (
      <div ref={ref} className={cn(sparklineVariants({ height }), className)} {...props}>
        {points.map((point, idx) => {
          const percent = (point.value / maxValue) * 100;
          const barHeight = Math.max(percent, 4); // Minimum 4% height for visibility
          // A point's own variant wins, so two points with the same value can differ (one good, one late).
          const variant = (point.getVariant?.(point.value, maxValue) ?? getVariant?.(point.value, maxValue) ?? 'neutral') as
            | 'success'
            | 'warning'
            | 'error'
            | 'info'
            | 'neutral';

          return (
            <div
              key={idx}
              className={cn(sparklineBarVariants({ variant }))}
              style={{ minHeight: `${barHeight}%` }}
              title={point.label ?? `Value: ${point.value}`}
            />
          );
        })}
      </div>
    );
  }
);

Sparkline.displayName = 'Sparkline';

