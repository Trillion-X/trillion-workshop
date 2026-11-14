// frontends/web/src/packages/ui/text/Text.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical polymorphic Text component for the Bitfield Studio. Every text
// element in the codebase MUST use this component — no raw <span>, <p>, <h1>,
// <label> with inline Tailwind classes. Backed by class-variance-authority
// (CVA) for type-safe variant composition.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. SINGLE SOURCE OF TRUTH for all text styling — no inline text patterns
// 2. Polymorphic: `as` prop controls rendered HTML element; variant provides
//    a sensible default element (headings -> h1-h4, body -> p, label -> span)
// 3. CVA handles ALL variant logic — no manual class string assembly
// 4. className prop merges via cn() — consumer overrides always win
// 5. `color` variant overrides the variant's built-in color when specified
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

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';

/**
 * CVA variant definitions for Text.
 *
 * Variants:
 *   - variant:  semantic text style (title, heading-xl/lg/md/xs, body, body-xs, label, caption)
 *   - color:    override the variant's built-in color (white/strong/muted/subtle/faint/ghost/dim/accent/error/warning/success/info)
 *   - weight:   font weight override
 *   - mono:     monospace font toggle
 *   - tabular:  tabular-nums toggle for numeric alignment
 *   - truncate: single-line truncation with ellipsis
 *   - align:    text alignment
 *   - wrap:     whitespace handling
 *   - leading:  line height control
 *   - clamp:    multi-line clamping (1-3 lines)
 *
 * All color tokens reference tailwind.config.ts `status.*` and `accent.*`.
 */
export const textVariants = cva('', {
  variants: {
    variant: {
      'display':    'text-[length:var(--font-size-display)] font-bold text-[var(--text-primary)]',
      'heading-2xl':'text-[length:var(--font-size-heading-2xl)] font-bold text-[var(--text-primary)]',
      'body-lg':    'text-[length:var(--font-size-body-lg)] text-[var(--text-primary)]',
      'heading-xl': 'text-[length:var(--font-size-heading-xl)] font-semibold text-[var(--text-primary)]',
      'heading-lg': 'text-[length:var(--font-size-heading-lg)] font-semibold text-[var(--text-primary)]',
      'heading':    'text-[length:var(--font-size-heading)] font-medium text-[var(--text-primary)]',
      // A screen's own title, in the look's display face (--font-display): the one line that names where you are.
      'title':      'font-[family-name:var(--font-display,inherit)] text-[length:var(--font-size-heading-lg)] font-medium text-[var(--text-primary)]',
      'heading-xs': 'text-[length:var(--font-size-heading-xs)] font-semibold text-[var(--text-secondary)]',
      'body':       'text-[length:var(--font-size-body)] text-[var(--text-primary)]',
      'body-xs':    'text-[length:var(--font-size-body-xs)] text-[var(--text-primary)]',
      'label':      'text-[length:var(--font-size-label)] text-[var(--text-tertiary)]',
      'caption':    'text-[length:var(--font-size-caption)] text-[var(--text-muted)]',
    },
    color: {
      default:   '',
      white:     'text-[var(--text-primary)]',
      primary:   'text-[var(--text-primary)]',
      strong:    'text-[var(--text-strong)]',
      secondary: 'text-[var(--text-secondary)]',
      muted:     'text-[var(--text-secondary)]',
      subtle:    'text-[var(--text-subtle)]',
      faint:     'text-[var(--text-muted)]',
      ghost:     'text-[var(--text-ghost)]',
      dim:       'text-[var(--text-dim)]',
      accent:    'text-accent-purple',
      error:     'text-status-error',
      warning:   'text-status-warning',
      success:   'text-status-success',
      info:      'text-status-info',
    },
    weight: {
      normal:    '',
      medium:    'font-medium',
      semibold:  'font-semibold',
      bold:      'font-bold',
    },
    mono: {
      true:  'font-mono',
      false: '',
    },
    tabular: {
      true:  'tabular-nums',
      false: '',
    },
    truncate: {
      true:  'truncate',
      false: '',
    },
    align: {
      left:   '',
      center: 'text-center',
      right:  'text-right',
    },
    wrap: {
      normal:   '',
      preserve: 'whitespace-pre-wrap break-words',
      nowrap:   'whitespace-nowrap',
      truncate: 'truncate',
    },
    leading: {
      normal:  '',
      tight:   'leading-tight',
      snug:    'leading-snug',
      relaxed: 'leading-relaxed',
    },
    breakAll: {
      true: 'break-all',
    },
    clamp: {
      none: '',
      1:    'line-clamp-1',
      2:    'line-clamp-2',
      3:    'line-clamp-3',
    },
  },
  defaultVariants: {
    variant:  'body',
    breakAll: false,
    color:    'default',
    weight:   'normal',
    mono:     false,
    tabular:  false,
    truncate: false,
    align:    'left',
    wrap:     'normal',
    leading:  'normal',
    clamp:    'none',
  },
});

/** Default HTML element per variant — headings get h1-h4, body gets p, inline gets span. */
const DEFAULT_ELEMENTS: Record<string, React.ElementType> = {
  'display':    'h1',
  'heading-2xl':'h1',
  'heading-xl': 'h1',
  'heading-lg': 'h2',
  'heading':    'h3',
  'title':      'h2',
  'heading-xs': 'h4',
  'body-lg':    'p',
  'body':       'p',
  'body-xs':    'p',
  'label':      'span',
  'caption':    'span',
};

/**
 * Props for the polymorphic Text component.
 *
 * Generic parameter T controls which HTML element renders:
 *   - Explicit: `<Text as="label" htmlFor="x">` — renders <label>
 *   - Implicit: variant determines default element (heading-xl -> h1, body -> p)
 *   - `color` from native HTML is excluded to avoid conflict with CVA color variant
 */
export type TextProps<T extends React.ElementType = 'span'> = {
  /** Override the rendered HTML element (e.g., 'span', 'label', 'h1') */
  as?: T;
  children?: React.ReactNode;
  className?: string;
  muted?: boolean;
  title?: string;
} & VariantProps<typeof textVariants>
  & Omit<React.ComponentPropsWithoutRef<T>, 'color'>;

/**
 * Canonical polymorphic Text component.
 *
 * Renders a styled text element. The `as` prop overrides the element type;
 * otherwise the variant determines the default element (heading-xl -> h1,
 * body -> p, label -> span, etc.).
 *
 * @example
 * ```tsx
 * <Text variant="heading-xl">Dashboard</Text>
 * <Text variant="label" color="faint">Last updated</Text>
 * <Text variant="body-xs" mono tabular>1,234</Text>
 * <Text as="label" variant="label" htmlFor="name">Name</Text>
 * ```
 */
export function Text<T extends React.ElementType = 'span'>({
  as,
  variant = 'body',
  color,
  weight,
  mono,
  tabular,
  truncate,
  align,
  wrap,
  leading,
  clamp,
  muted,
  breakAll,
  className,
  style,
  children,
  ...props
}: TextProps<T> & { breakAll?: boolean; style?: React.CSSProperties }) {
  const Component = as ?? DEFAULT_ELEMENTS[variant ?? 'body'] ?? 'span';
  return (
    <Component
      className={cn(
        textVariants({
          variant,
          color: color ?? (muted ? 'muted' : undefined),
          weight,
          mono,
          tabular,
          truncate,
          align,
          wrap,
          leading,
          clamp,
        }),
        className,
      )}
      style={breakAll ? { wordBreak: 'break-all', ...style } : style}
      {...props}
    >
      {children}
    </Component>
  );
}
