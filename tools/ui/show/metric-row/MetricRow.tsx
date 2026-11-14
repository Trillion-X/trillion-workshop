//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A horizontal strip of metric cells separated by vertical HAIRLINE dividers —
// the dense, quiet numeric row used by financial detail screens (reference
// anatomy: fey.com stock-detail metric cells — Mkt cap | P/E | EPS | …). Each
// cell is a tiny muted label over a mono/tabular value. The dividers are
// 1px --border-primary hairlines, NOT rounded chunky card borders.
//
// This is the fey counterpart to StatStrip. StatStrip centers its cells inside a
// rounded bordered box (a contained widget); MetricRow is a flat, edge-to-edge
// row of left-aligned cells joined only by hairlines — it belongs INSIDE a
// section, carrying no card chrome of its own. Both exist because they are
// genuinely different anatomies; this one is the restraint-grade financial row.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. PURE RENDERER: no data reads, no calculations. The caller pre-formats every
//    value string and chooses each cell's tone.
// 2. EMPTY = NOTHING: an empty cells list renders null.
// 3. HAIRLINE DIVIDERS ONLY: cells are joined by 1px --border-primary lines via
//    `divide-x` — never an outer rounded border, never a filled background.
// 4. MONO NUMERALS: values render mono + tabular so columns of digits align —
//    this is the financial-numeral discipline fey is built on.
// 5. TONE = SEMANTIC: a cell value may carry success/error/neutral tone (e.g. a
//    gain green, a loss red); the label stays muted regardless.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';
import { Text } from '../text';

export type MetricCellTone = 'neutral' | 'success' | 'error';

export interface MetricCell {
  /** Tiny muted label above the value (e.g. "Buying power"). */
  label: string;
  /** Pre-formatted display value (e.g. "$130,067.26", "30.30", "—"). */
  value: string;
  /** Value tone — gain (success), loss (error), or default (neutral). */
  tone?: MetricCellTone;
  /**
   * Mono + tabular numerals (default `true` — the financial-numeral discipline
   * so columns of digits align). Set `false` for a CATEGORICAL text value (e.g.
   * a state label "Locked in") — words read wrong in a mono tabular face, so
   * they render in the normal proportional body font. The caller decides per
   * cell from the value's own shape (L090); the row names no domain.
   */
  mono?: boolean;
}

export interface MetricRowProps {
  /** Cells in display order. Empty = renders nothing. */
  cells: readonly MetricCell[];
  /** 'between' (default): cells space out evenly. 'start': cells hug the left. */
  align?: 'between' | 'start';
  /** Row is the default hairline strip. Grid makes a compact two-column field. */
  layout?: 'row' | 'grid';
  className?: string;
}

const VALUE_COLOR: Record<MetricCellTone, 'strong' | 'success' | 'error'> = {
  neutral: 'strong',
  success: 'success',
  error: 'error',
};

/**
 * Hairline-divided strip of mono metric cells.
 *
 * @example
 * ```tsx
 * <MetricRow
 *   cells={[
 *     { label: 'Buying power', value: '$48,210' },
 *     { label: 'Positions', value: '3' },
 *     { label: 'Today', value: '+1.34%', tone: 'success' },
 *   ]}
 * />
 * ```
 */
export function MetricRow({ cells, align = 'between', layout = 'row', className }: MetricRowProps) {
  if (cells.length === 0) return null;
  return (
    <div
      className={cn(
        layout === 'grid'
          ? 'grid grid-cols-2 divide-x divide-y divide-[var(--border-primary)] border border-[var(--border-primary)]'
          : 'flex flex-row items-stretch divide-x divide-[var(--border-primary)]',
        layout === 'row' && (align === 'between' ? 'justify-between' : 'justify-start'),
        className,
      )}
      role="group"
      aria-label="Metrics"
    >
      {cells.map((cell, index) => (
        <div
          key={cell.label}
          className={cn(
            'flex min-w-0 flex-col gap-1',
            // No left padding on the first cell so the row aligns flush with the
            // section's left edge; interior cells get symmetric breathing room.
            layout === 'grid' ? 'min-h-28 justify-between p-4' : index === 0 ? 'pr-4' : 'px-4',
            layout === 'row' && align === 'between' ? 'flex-1' : '',
          )}
        >
          <Text variant="caption" color="faint" truncate>{cell.label}</Text>
          <Text
            variant="body"
            weight="medium"
            color={VALUE_COLOR[cell.tone ?? 'neutral']}
            mono={cell.mono ?? true}
            tabular={cell.mono ?? true}
            truncate
          >
            {cell.value}
          </Text>
        </div>
      ))}
    </div>
  );
}
