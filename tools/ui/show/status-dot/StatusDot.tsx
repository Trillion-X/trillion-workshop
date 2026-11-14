// bitfield-studio/frontends/web/src/packages/ui/status-dot/StatusDot.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical StatusDot component for the Bitfield Studio. Renders a
// small colored circle to indicate status (success, warning, error, info, idle).
// Built on class-variance-authority for type-safe variant composition, consuming
// status color tokens from tailwind.config.ts.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ALL colors use CSSOT design tokens (status-success, status-warning, etc.)
// 2. Variant + size + pulse composition via CVA
// 3. Forward ref for DOM access and composition with other libraries
// 4. Always provides accessible label via aria-label or sr-only text
// 5. Uses shrink-0 to prevent flex layout from collapsing the dot
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

const statusDotVariants = cva('rounded-full shrink-0', {
  variants: {
    status: {
      success: 'bg-status-success',
      warning: 'bg-status-warning',
      error: 'bg-status-error',
      info: 'bg-status-info',
      accent: 'bg-accent-purple',
      idle: 'bg-[var(--glass-bg-subtle)]',
    },
    size: {
      sm: 'w-1.5 h-1.5',
      md: 'w-2 h-2',
      lg: 'w-2.5 h-2.5',
    },
    pulse: {
      true: 'animate-pulse',
      false: '',
    },
  },
  defaultVariants: {
    status: 'idle',
    size: 'md',
    pulse: false,
  },
});

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

interface StatusDotProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusDotVariants> {
  /** Accessible label for screen readers. Rendered as sr-only text. */
  label?: string;
  /** Exact data-owned identity color. When present it overrides semantic fallback paint. */
  color?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Canonical status indicator dot for the Bitfield Studio.
 *
 * Renders a small colored circle with five status variants mapped directly
 * to the design system's status color tokens.
 *
 * @example
 * ```tsx
 * <StatusDot status="success" label="Running" />
 * <StatusDot status="error" size="lg" pulse />
 * <StatusDot status="idle" size="sm" />
 * ```
 */
const StatusDot = React.forwardRef<HTMLSpanElement, StatusDotProps>(
  ({ className, status, size, pulse, label, color, style, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(statusDotVariants({ status, size, pulse }), className)}
      style={color ? { ...style, backgroundColor: color } : style}
      aria-label={label}
      role={label ? 'status' : undefined}
      {...props}
    >
      {label && <span className="sr-only">{label}</span>}
    </span>
  )
);

StatusDot.displayName = 'StatusDot';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export { StatusDot, statusDotVariants };
export type { StatusDotProps };
