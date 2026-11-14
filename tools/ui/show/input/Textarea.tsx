// bitfield-studio/frontends/web/src/packages/ui/input/Textarea.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical Textarea component for the Bitfield Studio. Every
// multi-line text field in the application uses this component. Built on the
// glass-input design token with optional label and error state.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Uses glass-input composite class from global.css (SSOT for input styling)
// 2. Error state changes border color AND shows message below
// 3. resize-none by default — consumer overrides via className if needed
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

interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Optional label displayed above the textarea */
  label?: string;
  /** Error message — renders below textarea in red, changes border color */
  error?: string;
  /** Remove default glass border (keeps same background/padding/focus behavior) */
  borderless?: boolean;
  /** Grow the field height with its content (composer anatomy). The field
   *  resizes on every value change up to `maxHeight`, then scrolls. Owns the
   *  resize so consumers never hand-roll a ref + inline style (L065). */
  autoGrow?: boolean;
  /** Pixel cap for `autoGrow`. Beyond this the field stops growing and scrolls.
   *  Ignored unless `autoGrow` is set. */
  maxHeight?: number;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Canonical multi-line text input for the Bitfield Studio.
 *
 * Applies glassmorphism styling via the `glass-input` composite class.
 * Supports an optional label and error state with message.
 *
 * @example
 * ```tsx
 * <Textarea placeholder="Enter description..." rows={4} />
 * <Textarea label="Notes" error="Too short" />
 * ```
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, id, label, error, borderless = false, autoGrow = false, maxHeight, ...props }, ref) => {
    const generatedId = React.useId();
    const textareaId = id ?? generatedId;
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
    // Merge the forwarded ref with our internal one so autoGrow can measure the
    // node while the consumer still gets DOM access.
    const setRefs = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
      },
      [ref],
    );
    // Auto-grow: recompute height from content on every value change, capped at
    // maxHeight (then overflow-y-auto scrolls). Lives here so consumers never
    // hand-roll a ref + inline style in feature code (L065).
    React.useEffect(() => {
      if (!autoGrow) return;
      const el = innerRef.current;
      if (!el) return;
      el.style.height = 'auto';
      const next = typeof maxHeight === 'number' ? Math.min(el.scrollHeight, maxHeight) : el.scrollHeight;
      el.style.height = `${next}px`;
    }, [autoGrow, maxHeight, props.value]);
    return (
      <div>
        {label && (
          <label htmlFor={textareaId} className="block text-xs text-[var(--text-tertiary)] mb-1">{label}</label>
        )}
        <textarea
          id={textareaId}
          ref={setRefs}
          className={cn(
            'glass-input px-3 py-2 text-sm w-full min-h-[80px] resize-none',
            autoGrow && 'overflow-y-auto',
            // borderless = seamless writing surface (Amie/Typefully composer
            // anatomy): no border, no fill, no focus ring — the text IS the
            // field. !important on the focus shadow mirrors Input: .glass-input:focus
            // in global css carries equal specificity and later order, so without
            // the bang the "seamless" field still grew a focus border box.
            borderless && 'border-transparent bg-transparent !shadow-none focus:!shadow-none focus:!outline-none',
            error && 'border-status-error/50',
            className
          )}
          aria-invalid={error ? true : undefined}
          {...props}
        />
        {error && <p className="text-xs text-status-error mt-1">{error}</p>}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export { Textarea };
export type { TextareaProps };
