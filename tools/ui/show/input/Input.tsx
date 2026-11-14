// bitfield-studio/frontends/web/src/packages/ui/input/Input.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical Input component for the Bitfield Studio. Every text
// input field in the application uses this component. Built on the glass-input
// design token with optional label, error state, and left icon slot.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Uses glass-input composite class from global.css (SSOT for input styling)
// 2. Error state changes border color AND shows message below
// 3. Icon slot uses absolute positioning — input padding shifts to accommodate
// 4. Forward ref for DOM access and composition with form libraries
// 5. cn() merges consumer className without clobbering base styles
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

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Optional label displayed above the input */
  label?: string;
  /** Error message — renders below input in red, changes border color */
  error?: string;
  /** Helper text — renders below input in muted tone (suppressed while error is shown) */
  hint?: string;
  /** Optional left icon (React node, typically a lucide icon) */
  icon?: React.ReactNode;
  /** Remove default glass border (keeps same background/padding/focus behavior) */
  borderless?: boolean;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Canonical text input for the Bitfield Studio.
 *
 * Applies glassmorphism styling via the `glass-input` composite class.
 * Supports an optional label, left icon, and error state with message.
 *
 * @example
 * ```tsx
 * <Input placeholder="Search..." icon={<Search className="w-4 h-4" />} />
 * <Input label="Name" error="Required field" />
 * ```
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, id, label, error, hint, icon, borderless = false, ...props }, ref) => {
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    return (
      <div>
        {label && (
          <label htmlFor={inputId} className="block text-xs text-[var(--text-tertiary)] mb-2">{label}</label>
        )}
        <div className="relative">
          {icon && (
            <span className="pointer-events-none absolute left-3 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center text-[var(--text-muted)]">
              {icon}
            </span>
          )}
          <input
            id={inputId}
            ref={ref}
            className={cn(
              // h-9 matches Button md + SegmentedControl — toolbar rows of
              // [segments | input | button] sit flush at one height.
              'glass-input h-9 px-3 text-sm w-full',
              icon && 'pl-9',
              // borderless = seamless text field (Amie composer anatomy):
              // no border, no fill, no focus ring — the text IS the input.
              // !important on the focus shadow: .glass-input:focus in global css
              // carries the same specificity and later order — without the
              // bang the "seamless" field still grew a focus border box.
              borderless && 'border-transparent bg-transparent !shadow-none focus:!shadow-none focus:!outline-none',
              error && 'border-status-error/50',
              className
            )}
            aria-invalid={error ? true : undefined}
            {...props}
          />
        </div>
        {error && <p className="text-xs text-status-error mt-1">{error}</p>}
        {!error && hint && <p className="text-xs text-[var(--text-muted)] mt-1">{hint}</p>}
      </div>
    );
  }
);

Input.displayName = 'Input';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export { Input };
export type { InputProps };
