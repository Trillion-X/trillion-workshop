// packages/ui/show/native-color-picker/NativeColorPicker.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Shared browser-native color picking surface. The browser/OS owns the full
// color picker; this component owns only the small token-backed trigger panel
// around that native input.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure browser-local UI only: no reads, writes, feeds, or package behavior
// 2. Color value is caller-owned and data-driven
// 3. Uses native `<input type="color">` so the full system picker is reused
// 4. Save is optional; callers own what "saving" means
// 5. Feature packages must not duplicate color-picker chrome locally
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';
import { GLASS_POPOVER_BG_CLASS } from '../glass-tokens';
import { NamedIcon } from '../icon';

type NativeColorInputSize = 'sm' | 'md';

export interface NativeColorInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'type' | 'value' | 'onChange'> {
  value: string;
  controlSize?: NativeColorInputSize;
  onValueChange: (color: string) => void;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
}

export function NativeColorInput({
  value,
  controlSize = 'md',
  className,
  onValueChange,
  onChange,
  ...props
}: NativeColorInputProps) {
  return (
    <input
      {...props}
      type="color"
      value={value}
      onChange={(event) => {
        onValueChange(event.currentTarget.value);
        onChange?.(event);
      }}
      className={cn(
        'shrink-0 cursor-pointer rounded-lg border border-[var(--border-primary)] bg-transparent p-0',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-color)]',
        controlSize === 'sm' ? 'h-7 w-8' : 'h-9 w-12',
        className,
      )}
    />
  );
}

export interface NativeColorPickerPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  inputLabel?: string;
  saveLabel?: string;
  saveDisabled?: boolean;
  showSave?: boolean;
  onValueChange: (color: string) => void;
  onSave?: (color: string) => void;
}

export const NativeColorPickerPanel = React.forwardRef<HTMLDivElement, NativeColorPickerPanelProps>(
  ({
    value,
    inputLabel = 'Pick a color',
    saveLabel = 'Save color',
    saveDisabled = false,
    showSave = true,
    className,
    onValueChange,
    onSave,
    ...props
  }, ref) => (
    <div
      ref={ref}
      {...props}
      className={cn(
        'inline-flex items-center gap-2 rounded-2xl border border-[var(--border-primary)] px-3 py-2',
        GLASS_POPOVER_BG_CLASS + ' shadow-2xl backdrop-blur-2xl',
        className,
      )}
    >
      <NativeColorInput
        aria-label={inputLabel}
        value={value}
        onValueChange={onValueChange}
        onKeyDown={(event) => event.stopPropagation()}
      />
      {showSave ? (
        <button
          type="button"
          className={cn(
            'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold transition-colors',
            'bg-[var(--glass-bg-active)] text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-color)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          disabled={saveDisabled}
          onClick={() => onSave?.(value)}
        >
          <span>{saveLabel}</span>
          <NamedIcon name="Plus" size="sm" />
        </button>
      ) : null}
    </div>
  ),
);

NativeColorPickerPanel.displayName = 'NativeColorPickerPanel';
