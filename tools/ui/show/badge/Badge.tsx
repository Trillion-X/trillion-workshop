// frontends/web/src/packages/ui/badge/Badge.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical Badge component for the Bitfield Studio. Every inline badge/pill
// pattern in the codebase MUST use this component — no exceptions. Backed by
// class-variance-authority (CVA) for type-safe variant composition.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. SINGLE SOURCE OF TRUTH for all badge styling — no inline badge patterns
// 2. All variants map to design-system tokens (tailwind.config.ts)
// 3. CVA handles variant logic — no manual class string assembly
// 4. forwardRef for composability with parent layout components
// 5. className prop merges via cn() — consumer overrides always win
//
// =============================================================================
// SECURITY CONSIDERATIONS
// =============================================================================
//
// Children are rendered as React children (not dangerouslySetInnerHTML).
// No XSS vector. Safe for user-provided text content.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';

/**
 * CVA variant definitions for Badge.
 *
 * Variants:
 *   - variant: semantic color (success/warning/error/info/accent/neutral/muted)
 *   - size: semantic Screen Look typography roles
 *
 * All color tokens reference tailwind.config.ts `status.*` and `accent.*`.
 */
export const badgeVariants = cva(
  // Amie/Linear chips are rounded RECTANGLES (same radius family as calendar
  // day cells) — full-pill rounding read as over-rounded chrome.
  'inline-flex items-center gap-1.5 rounded-[var(--radius-chip)] shrink-0',
  {
    variants: {
      variant: {
        success: 'bg-[var(--badge-success-bg)] text-[var(--badge-success-text)]',
        warning: 'bg-status-warning/15 text-status-warning',
        error: 'bg-status-error/15 text-status-error',
        destructive: 'bg-status-error/15 text-status-error',
        info: 'bg-status-info/15 text-status-info',
        accent: 'bg-accent-purple/15 text-accent-purple',
        neutral: 'bg-[var(--glass-bg-hover)] text-[var(--text-tertiary)]',
        secondary: 'bg-[var(--glass-bg-hover)] text-[var(--text-tertiary)]',
        muted: 'bg-[var(--glass-bg-subtle)] text-[var(--text-muted)]',
        /** Outlined muted pill — subtle border + higher contrast text for labels */
        'muted-outline': 'bg-[var(--glass-bg-subtle)] text-[var(--text-strong)] border border-[var(--border-primary)] rounded-[var(--radius-chip)]',
      },
      interactive: {
        true: 'cursor-pointer transition-colors hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)]',
        false: '',
      },
      size: {
        /** Notification dot — tiny counter positioned absolutely over parent */
        dot: 'w-3 h-3 p-0 text-[length:var(--font-size-micro)] font-bold flex items-center justify-center',
        sm: 'px-1.5 py-0.5 text-[length:var(--font-size-caption)]',
        md: 'px-2 py-0.5 text-[length:var(--font-size-caption)]',
        lg: 'px-2.5 py-1 text-[length:var(--font-size-label)]',
      },
      weight: {
        medium: 'font-medium',
        semibold: 'font-semibold',
        bold: 'font-bold',
      },
    },
    defaultVariants: {
      variant: 'neutral',
      size: 'md',
      interactive: false,
      weight: 'medium',
    },
  }
);

/** Props for the Badge component — extends native span + CVA variants. */
export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  tone?: 'neutral' | 'green' | 'red';
}

/**
 * Canonical Badge component.
 *
 * Renders a styled pill/badge span. Accepts all native span attributes,
 * CVA variant/size props, and children as content.
 *
 * Adds `tabular-nums` automatically when children is a number or numeric
 * string so digit widths stay consistent across values.
 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, size, weight, tone, interactive, children, ...props }, ref) => {
    const isNumeric =
      typeof children === 'number' ||
      (typeof children === 'string' && children.length > 0 && !isNaN(Number(children)));
    const variantFromTone = tone === 'green'
      ? 'success'
      : tone === 'red'
        ? 'error'
        : tone === 'neutral'
          ? 'neutral'
          : undefined;

    return (
      <span
        ref={ref}
        className={cn(
          badgeVariants({ variant: variant ?? variantFromTone, size, weight, interactive }),
          isNumeric && 'tabular-nums',
          className,
        )}
        data-tone={tone}
        {...props}
      >
        {children}
      </span>
    );
  }
);

Badge.displayName = 'Badge';
