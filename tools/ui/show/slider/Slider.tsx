import * as React from 'react';

import { cn } from '../cn';
import { Text } from '../text';

export type SliderProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'min' | 'max' | 'step' | 'onChange'> & {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  description?: string;
  valueLabel?: string;
  resetLabel?: string;
  onValueChange: (value: number) => void;
  onReset?: () => void;
};

function defaultValueLabel(value: number, unit: string): string {
  return unit ? `${value}${unit}` : String(value);
}

export const Slider = React.forwardRef<HTMLInputElement, SliderProps>(({
  className,
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  description,
  valueLabel,
  resetLabel = 'Reset',
  disabled,
  onValueChange,
  onReset,
  ...props
}, ref) => {
  const displayedValue = valueLabel ?? defaultValueLabel(value, unit);

  return (
    <label
      className={cn(
        'flex flex-col gap-2 rounded-2xl border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] px-3 py-2',
        disabled && 'opacity-50',
        className,
      )}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <Text variant="body-xs" weight="semibold" className="truncate">{label}</Text>
          {description ? <Text variant="caption" color="faint" className="truncate">{description}</Text> : null}
        </span>
        <span className="flex items-center gap-2 text-[length:var(--font-size-caption)] tabular-nums text-[var(--text-muted)]">
          <span>{displayedValue}</span>
          {onReset ? (
            <button
              type="button"
              className="rounded-full px-2 py-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]"
              disabled={disabled}
              onClick={(event) => {
                event.preventDefault();
                onReset();
              }}
            >
              {resetLabel}
            </button>
          ) : null}
        </span>
      </span>
      <input
        ref={ref}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-[var(--glass-bg-hover)] accent-[var(--accent-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] disabled:cursor-not-allowed"
        onChange={(event) => onValueChange(event.currentTarget.valueAsNumber)}
        {...props}
      />
    </label>
  );
});

Slider.displayName = 'Slider';
