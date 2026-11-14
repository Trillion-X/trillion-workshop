import * as React from 'react';

import { cn } from '../cn';

export type SegmentedControlItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** A second, quieter line under the label (a change over the range, a count). Any choice with one makes every choice two lines tall. */
  note?: string;
  /** What the note means, for the look to colour (rise, fall): written as `data-note-tone`, never a colour. */
  noteTone?: string;
  disabled?: boolean;
};

export type SegmentedControlProps = {
  items: SegmentedControlItem[];
  value: string;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
};

export function SegmentedControl({
  items,
  value,
  ariaLabel,
  className,
  disabled,
  onValueChange,
}: SegmentedControlProps) {
  const noted = items.some((item) => item.note);
  return (
    // A corner holder (screen-look nested-corners.css): its choices' corners follow its own, less the line and padding.
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-segmented-control=""
      data-corner-holder=""
      data-noted={noted ? 'true' : undefined}
      className={cn(
        'inline-flex max-w-full items-center gap-0.5 border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] p-0.5',
        noted ? 'h-12' : 'h-9',
        disabled && 'opacity-50',
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={item.note ? `${item.label}, ${item.note}` : item.label}
            title={item.note ? `${item.label}, ${item.note}` : item.label}
            disabled={disabled || item.disabled}
            data-corner-follows=""
            className={cn(
              'inline-flex h-full shrink-0 items-center justify-center gap-2 px-3 text-xs font-semibold text-[var(--text-muted)] transition-colors',
              'hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-40',
              selected && 'bg-[var(--glass-bg-active)] text-[var(--text-primary)] shadow-sm',
            )}
            onClick={() => onValueChange(item.id)}
          >
            {item.icon ? <span className="shrink-0" aria-hidden="true">{item.icon}</span> : null}
            {item.note ? (
              <span className="flex flex-col items-center leading-tight">
                <span className="whitespace-nowrap">{item.label}</span>
                <span className="whitespace-nowrap text-[0.9em] font-medium" data-segmented-note="" data-note-tone={item.noteTone}>{item.note}</span>
              </span>
            ) : <span className="whitespace-nowrap">{item.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
