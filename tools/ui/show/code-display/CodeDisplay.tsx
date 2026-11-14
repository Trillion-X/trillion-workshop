// bitfield-studio/frontends/web/src/packages/ui/code-display/CodeDisplay.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Displays a sequence of characters in individual glass-styled boxes, typically
// used for pairing codes, OTP codes, or any short alphanumeric string. Each
// character gets its own box with monospace font for clear readability.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Uses glass design tokens from global.css (--glass-bg-secondary, --border-*)
// 2. Each character rendered in its own box — no single text field
// 3. cn() merges consumer className without clobbering base styles
// 4. Responsive sizing via CSS — readable at both mobile and desktop scales
// 5. Read-only display — this is NOT an input component
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

interface CodeDisplayProps {
  /** The code string to display (each character gets its own box) */
  code: string;
  /** Optional label displayed above the code */
  label?: string;
  /** Size variant: sm (32px), md (48px), lg (60px) boxes */
  size?: 'sm' | 'md' | 'lg';
  /** Additional className for the outer container */
  className?: string;
}

// ---------------------------------------------------------------------------
// SIZE MAP
// ---------------------------------------------------------------------------

const sizeClasses = {
  sm: 'w-8 h-10 text-base',
  md: 'w-12 h-14 text-xl',
  lg: 'w-[60px] h-[68px] text-2xl',
} as const;

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Displays a code string as individual character boxes.
 *
 * Uses glass design tokens for consistent styling with the rest
 * of the Bitfield Studio UI. Each character is rendered in its own
 * box with monospace font for unambiguous readability.
 *
 * @example
 * ```tsx
 * <CodeDisplay code="A3X9K2" label="Pairing Code" size="lg" />
 * ```
 */
const CodeDisplay = React.forwardRef<HTMLDivElement, CodeDisplayProps>(
  ({ code, label, size = 'lg', className }, ref) => {
    const chars = code.split('');

    return (
      <div ref={ref} className={cn('flex flex-col items-center gap-3', className)}>
        {label && (
          <span className="text-xs text-[var(--text-tertiary)]">
            {label}
          </span>
        )}
        <div className="flex items-center gap-2.5">
          {chars.map((char, i) => (
            <div
              key={i}
              className={cn(
                'flex items-center justify-center',
                'glass-input font-mono font-semibold tracking-widest',
                'select-all cursor-default',
                sizeClasses[size],
              )}
              aria-label={`Character ${i + 1}: ${char}`}
            >
              {char}
            </div>
          ))}
        </div>
      </div>
    );
  }
);

CodeDisplay.displayName = 'CodeDisplay';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export { CodeDisplay };
export type { CodeDisplayProps };
