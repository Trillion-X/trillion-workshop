// packages/ui/show/color-picker-popover/ColorPickerPopover.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// In-app, anchored color picker. The shared ColorWheel (hex in / hex out) floated
// next to a trigger via AnchoredOverlay — portaled to <body>, auto-flipped to stay
// on screen, draggable, with an optional "Save" affordance.
//
// This is the in-app alternative to the browser-native `<input type="color">`,
// whose OS picker the browser positions itself (often top-of-screen, far from the
// trigger). Any feature that wants a color picker that appears NEXT TO its button
// composes this — never a native input, never hand-rolled popover chrome.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure browser-local UI: no reads, writes, feeds, or package behavior.
// 2. Color is caller-owned: `value` (hex) in, `onChange(hex)` out.
// 3. Open/anchor/dismiss are caller-owned — this owns only the floating chrome.
// 4. Save is optional; the caller decides what "saving" means.
// =============================================================================

import React from 'react';
import { AnchoredOverlay } from '../anchored-overlay';
import { ColorWheel } from '../color-wheel';
import { NamedIcon } from '../icon';
import { cn } from '../cn';

export interface ColorPickerPopoverProps {
  /** The element the popover floats next to. */
  anchorRef: React.RefObject<HTMLElement>;
  open: boolean;
  /** Current color (hex). */
  value: string;
  /** Emitted on every wheel/swatch change as #rrggbb(aa). */
  onChange: (hex: string) => void;
  /** Outside pointer-down / escape. */
  onDismiss: () => void;
  /** When set, a Save button appears; the caller persists the color. */
  onSave?: (hex: string) => void;
  saveLabel?: string;
  /** Preset swatches shown under the wheel (black + white added automatically). */
  presets?: readonly string[];
  /** Preferred side; AnchoredOverlay still flips to stay on screen. Default 'above'. */
  placement?: 'above' | 'below';
  /** Wheel diameter in px. */
  size?: number;
  title?: string;
}

export function ColorPickerPopover({
  anchorRef,
  open,
  value,
  onChange,
  onDismiss,
  onSave,
  saveLabel = 'Save color',
  presets,
  placement = 'above',
  size = 208,
  title = 'Pick a color',
}: ColorPickerPopoverProps) {
  return (
    <AnchoredOverlay
      anchorRef={anchorRef}
      open={open}
      placement={placement}
      draggable
      title={title}
      onDismiss={onDismiss}
    >
      <div
        role="dialog"
        aria-label={title}
        style={{ backgroundColor: 'var(--black-rich)' }}
        className="flex flex-col gap-2 rounded-b-2xl border border-t-0 border-[var(--border-primary)] p-3 shadow-2xl"
      >
        <ColorWheel value={value} onChange={onChange} size={size} presets={presets} />
        {onSave ? (
          <button
            type="button"
            className={cn(
              'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold transition-colors',
              'bg-[var(--glass-bg-active)] text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-color)]',
            )}
            onClick={() => onSave(value)}
          >
            <span>{saveLabel}</span>
            <NamedIcon name="Plus" size="sm" />
          </button>
        ) : null}
      </div>
    </AnchoredOverlay>
  );
}
