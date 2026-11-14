// bitfield-studio/frontends/web/src/packages/ui/color-dot/ColorDot.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical ColorDot component for inline colored indicators. Either an
// arbitrary hex color (legends, charts, where the color comes from data) or a
// named palette `tone` (a colour a person chose from a DATA palette, such as a
// space's colour), which screen-look draws per look through `data-colour`.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Takes a color prop (hex or CSS color value) or a tone prop (a palette id
//    screen-look resolves; no colour value is written by the component)
// 2. Renders a small circle, or a caller-requested spine representing a record's
//    data color. Screen Look owns the spine geometry inside its positioned host.
// 3. Uses inline style for color (the ONLY exception to L065) because color
//    is data-driven, not hardcoded styling; a tone never uses inline style
// 4. Forward ref for DOM access
// 5. Accessible with optional label
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

const colorDotVariants = cva('inline-block align-middle rounded-full shrink-0', {
  variants: {
    size: {
      xs: 'w-1.5 h-1.5',
      sm: 'w-2 h-2',
      md: 'w-2.5 h-2.5',
      lg: 'w-3 h-3',
    },
  },
  defaultVariants: {
    size: 'sm',
  },
});

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

type ColorDotProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'color'> &
  VariantProps<typeof colorDotVariants> & {
    /** Accessible label for screen readers */
    label?: string;
    /** A data-color marker; the spine follows its positioned record host. */
    shape?: 'dot' | 'spine';
  } & (
    /** Hex or CSS color value for the dot */
    | { color: string; tone?: never }
    /** A palette id; screen-look paints `[data-colour="<id>"]` in the current look */
    | { tone: string; color?: never }
  );

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Colored dot indicator with arbitrary hex/CSS colors.
 *
 * EXCEPTION TO L065: Uses inline style for `backgroundColor` because the
 * color is data-driven (from TOOL_COLORS, chart data, etc.), not hardcoded
 * styling. The style is bound to data, not design decisions.
 *
 * @example
 * ```tsx
 * <ColorDot color="#10b981" label="Read tool" />
 * <ColorDot color="#3b82f6" size="lg" />
 * <ColorDot tone="green" label="Green" />
 * ```
 */
const ColorDot = React.forwardRef<HTMLSpanElement, ColorDotProps>(
  ({ className, size, color, tone, label, shape = 'dot', ...props }, ref) => (
    <span
      ref={ref}
      className={cn(colorDotVariants({ size }), 'color-marker', tone && 'colour-dot', className)}
      data-color-marker-shape={shape}
      {...(tone ? { 'data-colour': tone } : { style: { backgroundColor: color } })}
      aria-label={label}
      role={label ? 'presentation' : undefined}
      {...props}
    >
      {label && <span className="sr-only">{label}</span>}
    </span>
  )
);

ColorDot.displayName = 'ColorDot';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export { ColorDot, colorDotVariants };
export type { ColorDotProps };
