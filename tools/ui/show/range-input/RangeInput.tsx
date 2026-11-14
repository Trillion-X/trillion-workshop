// packages/ui/show/range-input/RangeInput.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A BARE horizontal range control — just a track + thumb, nothing else. This is
// the inline sibling of `Slider` (which is a full bordered settings ROW with a
// label, a description, and a value pill). When a control already has its own
// surrounding chrome — a zoom cluster `[-] [====] 79% [+]`, a compact inspector
// row — the heavy Slider card is wrong: it draws a second border, repeats the
// value, and on a small screen its fixed min-width wraps badly. RangeInput is the
// minimal primitive for those places: you bring the chrome, it brings the track.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. ZERO domain vocabulary — pure input Physics, reusable by any host.
// 2. NO value text, NO label card — the caller owns all surrounding chrome. (If
//    you want the labeled settings-row form, use `Slider`, not this.)
// 3. `aria-label` is REQUIRED (it has no visible label of its own) — a11y floor.
// =============================================================================

import * as React from 'react';

import { cn } from '../cn';

export type RangeInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'min' | 'max' | 'step' | 'onChange'
> & {
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Required — this control has no visible label of its own. */
  readonly 'aria-label': string;
  readonly onValueChange: (value: number) => void;
  /** Track width (defaults to a compact inline width). */
  readonly width?: number | string;
};

export const RangeInput = React.forwardRef<HTMLInputElement, RangeInputProps>(
  ({ className, value, min = 0, max = 100, step = 1, disabled, onValueChange, width = 96, style, ...props }, ref) => (
    <input
      ref={ref}
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      style={{ width, ...style }}
      className={cn(
        'h-1.5 cursor-pointer appearance-none rounded-full bg-[var(--glass-bg-hover)] accent-[var(--accent-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      onChange={(event) => onValueChange(event.currentTarget.valueAsNumber)}
      {...props}
    />
  ),
);

RangeInput.displayName = 'RangeInput';
