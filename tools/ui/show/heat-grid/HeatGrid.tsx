import * as React from 'react';

import { cn } from '../cn';
import { Text } from '../text';

// HeatGrid — read-only spatial heat display. Renders a flat array of bucket
// counts as a grid of cells whose fill intensity encodes magnitude. Read-only
// sibling of position-grid; reuses the same screen-look tokens. Intensity is a
// discrete opacity step of one token color (token-driven, no inline style, no
// new token). Names no domain — placement zones, shot charts, pitch maps are
// the same component fed different counts/columns/labels.

export type HeatGridProps = {
  label?: string;
  /** Per-cell values, row-major. Empty/absent → an honest empty state. */
  counts: number[];
  /** Cells per row (defaults to one row of counts.length). */
  columns?: number;
  /** Per-cell captions, parallel to counts. */
  cellLabels?: string[];
  /** Caption shown on the right of the header. */
  valueLabel?: string;
  className?: string;
};

const INTENSITY_OPACITY = ['opacity-0', 'opacity-20', 'opacity-45', 'opacity-70', 'opacity-95'] as const;

function intensityClass(value: number, max: number): string {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) return INTENSITY_OPACITY[0];
  const bucket = Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
  return INTENSITY_OPACITY[bucket];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function HeatGrid({ label, counts, columns, cellLabels, valueLabel, className }: HeatGridProps) {
  const cells = Array.isArray(counts) ? counts : [];
  const cols = Math.max(1, columns ?? Math.max(1, cells.length));
  const max = cells.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), 0);

  return (
    <div
      className={cn(
        'rounded-2xl border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] p-3',
        className,
      )}
      data-component="heat-grid"
    >
      {(label || valueLabel) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {label ? <Text variant="body-xs" weight="semibold">{label}</Text> : <span />}
          {valueLabel ? <Text variant="caption" color="faint">{valueLabel}</Text> : null}
        </div>
      )}
      {cells.length === 0 ? (
        <Text variant="caption" color="faint">No data yet</Text>
      ) : (
        <div className="grid auto-rows-fr gap-1.5" data-heat-cols={cols}>
          {chunk(cells, cols).map((rowCells, r) => (
            <div key={r} className="grid grid-flow-col auto-cols-fr gap-1.5">
              {rowCells.map((value, c) => {
                const index = r * cols + c;
                return (
                  <div
                    key={index}
                    data-heat-cell={index}
                    data-heat-value={value}
                    aria-label={`${cellLabels?.[index] ?? `zone ${index + 1}`}: ${Number.isFinite(value) ? value : 0}`}
                    className="relative flex h-12 items-start justify-start overflow-hidden rounded-lg border border-[var(--border-primary)]"
                  >
                    <div
                      aria-hidden="true"
                      className={cn('absolute inset-0 bg-[var(--text-primary)]', intensityClass(value, max))}
                    />
                    {cellLabels?.[index] ? (
                      <Text variant="caption" color="faint" className="relative z-10 m-1">
                        {cellLabels[index]}
                      </Text>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
