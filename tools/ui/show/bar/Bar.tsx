// frontends/web/src/packages/ui/bar/Bar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Bar component for progress/stacked visualization. Renders a horizontal bar
// with optional stacked segments, color variants, and customizable segments.
// Used for analytics, progress indication, and data visualization.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. PURE COMPONENT: No inline styles beyond segment width percentages
// 2. SEGMENTS: Array of {value, percent, variant} for stacked bars
// 3. HEIGHT: Consistent default height with customizable override
// 4. ACCESSIBILITY: title attributes on segments for hover tooltips
//
// =============================================================================

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

export const barVariants = cva('rounded overflow-hidden', {
  variants: {
    height: {
      xs: 'h-2',
      sm: 'h-3',
      md: 'h-5',
      lg: 'h-6',
    },
    background: {
      default: 'bg-[var(--glass-bg-subtle)]',
      dark: 'bg-[var(--glass-bg-hover)]',
    },
  },
  defaultVariants: {
    height: 'md',
    background: 'default',
  },
});

export const barSegmentVariants = cva('transition-colors', {
  variants: {
    variant: {
      success: 'bg-status-success/60 hover:bg-status-success/80',
      warning: 'bg-status-warning/60 hover:bg-status-warning/80',
      error: 'bg-status-error/40 hover:bg-status-error/60',
      info: 'bg-status-info/60 hover:bg-status-info/80',
      accent: 'bg-accent-purple/60 hover:bg-accent-purple/80',
      neutral: 'bg-[var(--glass-bg-active)] hover:bg-[var(--glass-bg-subtle)]0',
    },
  },
  defaultVariants: {
    variant: 'neutral',
  },
});

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface BarSegment {
  percent: number;
  variant: 'success' | 'warning' | 'error' | 'info' | 'accent' | 'neutral';
  title?: string;
}

export interface BarProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof barVariants> {
  segments: BarSegment[];
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Bar component for stacked visualization.
 *
 * Renders a horizontal bar with colored segments. Each segment represents
 * a percentage of the total bar width.
 *
 * @example
 * ```tsx
 * <Bar
 *   segments={[
 *     { percent: 60, variant: 'success', title: 'Completed: 60%' },
 *     { percent: 20, variant: 'warning', title: 'Deferred: 20%' },
 *     { percent: 20, variant: 'error', title: 'Pending: 20%' },
 *   ]}
 *   height="md"
 * />
 * ```
 */
export const Bar = React.forwardRef<HTMLDivElement, BarProps>(
  ({ className, height, background, segments, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(barVariants({ height, background }), className)}
        {...props}
      >
        {segments.map((segment, idx) => (
          <div
            key={idx}
            className={barSegmentVariants({ variant: segment.variant })}
            style={{ width: `${segment.percent}%` }}
            title={segment.title}
          />
        ))}
      </div>
    );
  }
);

Bar.displayName = 'Bar';

