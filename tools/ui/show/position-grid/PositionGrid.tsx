import * as React from 'react';

import { cn } from '../cn';
import { Text } from '../text';

export type PositionGridProps = {
  label: string;
  value: string;
  rows?: number;
  columns?: number;
  className?: string;
  disabled?: boolean;
  valueLabel?: string;
  onValueChange: (value: string) => void;
};

function keyFor(row: number, column: number): string {
  return `${row}:${column}`;
}

export function PositionGrid({
  label,
  value,
  rows = 5,
  columns = 5,
  className,
  disabled,
  valueLabel,
  onValueChange,
}: PositionGridProps) {
  const rowIndexes = Array.from({ length: Math.max(1, rows) }, (_, index) => index);
  const columnIndexes = Array.from({ length: Math.max(1, columns) }, (_, index) => index);

  return (
    <div
      className={cn(
        'rounded-2xl border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] p-3',
        disabled && 'opacity-50',
        className,
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <Text variant="body-xs" weight="semibold">{label}</Text>
        {valueLabel ? <Text variant="caption" color="faint">{valueLabel}</Text> : null}
      </div>
      <div className="flex flex-col gap-2" role="radiogroup" aria-label={label}>
        {rowIndexes.map((row) => (
          <div key={row} className="grid grid-flow-col auto-cols-fr gap-2">
            {columnIndexes.map((column) => {
              const itemValue = keyFor(row, column);
              const selected = itemValue === value;
              return (
                <button
                  key={itemValue}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`${label} ${row + 1}, ${column + 1}`}
                  disabled={disabled}
                  className={cn(
                    'flex h-6 items-center justify-center rounded-full transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] disabled:cursor-not-allowed',
                    'hover:bg-[var(--glass-bg-hover)]',
                  )}
                  onClick={() => onValueChange(itemValue)}
                >
                  <span
                    className={cn(
                      'block h-2 w-2 rounded-full bg-[var(--text-muted)] transition-all',
                      selected && 'h-3.5 w-3.5 bg-[var(--text-primary)] shadow-sm',
                    )}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
