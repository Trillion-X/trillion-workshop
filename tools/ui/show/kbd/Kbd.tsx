// frontends/web/src/packages/ui/kbd/Kbd.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Keyboard shortcut display component. Renders a styled <kbd> element for
// displaying keyboard shortcuts in UI. Two variants: default (full-size) and
// sm (compact for inline hints). Uses glassmorphism styling per design-system.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Two size variants: 'default' (text-xs px-2 py-0.5) and 'sm' (text-[length:var(--font-size-caption)] px-1.5 py-0.5)
// 2. Glassmorphism: bg-[var(--glass-bg-hover)] border border-[var(--border-secondary)] rounded font-mono
// 3. Renders as semantic <kbd> HTML element
// 4. Extends React.HTMLAttributes for full flexibility (className, etc.)
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

export const kbdVariants = cva(
  'inline-flex items-center justify-center bg-[var(--glass-bg-hover)] border border-[var(--border-secondary)] rounded font-mono text-[var(--text-secondary)]',
  {
    variants: {
      size: {
        default: 'text-xs px-2 py-0.5',
        sm: 'text-[length:var(--font-size-caption)] px-1.5 py-0.5',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

export interface KbdProps extends React.HTMLAttributes<HTMLElement>, VariantProps<typeof kbdVariants> {}

export function Kbd({ className, size, ...props }: KbdProps) {
  return <kbd className={cn(kbdVariants({ size }), className)} {...props} />;
}
