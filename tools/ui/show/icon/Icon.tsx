// bitfield-studio/frontends/web/src/packages/ui/icon/Icon.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical Icon component for Bitfield Studio. Every icon
// in the application uses this component. Built on class-variance-authority for
// type-safe size composition — consumers NEVER pass w-*/h-* classes directly.
//
// Accepts any Lucide icon component via the `icon` prop. Handles sizing,
// color, and flex-shrink behavior through CVA variants.
//
// Consumer files MUST NOT pass sizing classes (w-*, h-*) via className.
// All sizing is handled through the `size` prop. className is ONLY for
// layout (mt-*, ml-*, absolute, etc.).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ALL sizing uses CVA size variants — no manual w-*/h-* classes
// 2. ALL colors use design token color variants — no manual text-* classes
// 3. Always includes shrink-0 to prevent flex collapse
// 4. Forward ref for DOM access and composition
// 5. Accepts any Lucide icon component via `icon` prop
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Brain, ImageOff, Inbox, NotebookPen, Square } from 'lucide-react';
import type { LucideProps } from 'lucide-react';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

const iconVariants = cva('shrink-0', {
  variants: {
    size: {
      /** 12px — tiny indicators, inline with caption text */
      xs: 'w-3 h-3',
      /** 14px — small, inline with body-xs text */
      sm: 'w-3.5 h-3.5',
      /** 16px — default, inline with body text and buttons */
      md: 'w-4 h-4',
      /** 20px — prominent, section headers and large buttons */
      lg: 'w-5 h-5',
      /** 24px — hero icons, empty states */
      xl: 'w-6 h-6',
    },
    color: {
      /** Inherits current text color */
      inherit: '',
      /** Primary white */
      white: 'text-[var(--text-primary)]',
      /** Muted white/70 */
      muted: 'text-[var(--text-secondary)]',
      /** Subtle white/60 */
      subtle: 'text-[var(--text-tertiary)]',
      /** Faint white/40 */
      faint: 'text-[var(--text-muted)]',
      /** Ghost white/20 */
      ghost: 'text-[var(--text-dim)]',
      /** Accent purple */
      accent: 'text-accent-purple',
      /** Error red */
      error: 'text-status-error',
      /** Warning amber */
      warning: 'text-status-warning',
      /** Success green */
      success: 'text-status-success',
      /** Info blue */
      info: 'text-status-info',
    },
  },
  defaultVariants: {
    size: 'md',
    color: 'inherit',
  },
});

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

interface IconProps
  extends Omit<React.SVGAttributes<SVGElement>, 'color'>,
    VariantProps<typeof iconVariants> {
  /** Lucide icon component to render */
  icon?: React.ElementType<LucideProps>;
  /** Generic icon name alias for package data or copied package surfaces. */
  name?: string;
}

const NAMED_ICONS: Record<string, React.ElementType<LucideProps>> = {
  brain: Brain,
  ImageOff,
  imageOff: ImageOff,
  inbox: Inbox,
  notepad: NotebookPen,
};

function resolveIcon(icon: React.ElementType<LucideProps> | undefined, name: string | undefined) {
  if (icon) return icon;
  return name ? NAMED_ICONS[name] ?? Square : Square;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Canonical icon wrapper for Bitfield Studio.
 *
 * Wraps any Lucide icon with standardized sizing and color variants.
 * Consumers select size via prop — never via className.
 *
 * @example
 * ```tsx
 * <Icon icon={ChevronRight} size="md" />
 * <Icon icon={AlertTriangle} size="lg" color="warning" />
 * <Icon icon={X} size="lg" color="faint" />
 * <Icon icon={Check} size="sm" color="success" />
 * ```
 */
const Icon = React.forwardRef<SVGSVGElement, IconProps>(
  ({ className, icon, name, size, color, ...props }, ref) => {
    const LucideIcon = resolveIcon(icon, name);
    return (
      <LucideIcon
        ref={ref}
        className={cn(iconVariants({ size, color }), className)}
        {...props}
      />
    );
  }
);

Icon.displayName = 'Icon';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export { Icon, iconVariants };
export type { IconProps };
