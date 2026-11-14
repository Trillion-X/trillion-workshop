// packages/choose-per-observer/show/metric-format.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Turn one metric descriptor's raw value into a human display string, dispatched
// by the descriptor's DATA format hint through an extensible REGISTRY — never a
// switch on a field id or a closed format union baked into a surface. A new
// format kind is one registry entry; the scoreboard + profile both feed this to
// RecordMetricRow's `formatValue`.
//
// THE GENERIC TEST: add a "duration" or "ratio" format by registering one
// formatter; zero change to either surface. An unknown hint falls back to plain
// text (a value never disappears because a hint was novel).
//
// Pure: no React, no I/O. Node-testable.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { VisualDatabaseFieldDescriptor } from '@/packages/visual-database/read-data/visual-database';
import type { RecordMetricFormat } from '@/packages/visual-database/show/RecordMetricRow';
import { metricFormatHint } from '@/packages/choose-per-observer/data/scoreboard-descriptors';

/** Options a formatter may need from the caller (owner DATA), e.g. the currency
 *  symbol. Kept open so a new format kind can read a new option with zero churn. */
export interface MetricFormatOptions {
  currencySymbol?: string;
}

/** One formatter: raw value + options -> a display string + optional tone. */
export type MetricFormatter = (value: unknown, options: MetricFormatOptions) => RecordMetricFormat;

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

const DASH = '—';

/** The extensible registry of format kinds. Owners/packages add entries; the
 *  surfaces never enumerate format kinds. */
export const METRIC_FORMATTERS: Record<string, MetricFormatter> = {
  integer(value) {
    const n = toNumber(value);
    if (n === null) return { value: DASH, tone: 'neutral' };
    return { value: Math.round(n).toLocaleString('en-US'), tone: 'neutral' };
  },
  currency(value, options) {
    const n = toNumber(value);
    const symbol = options.currencySymbol ?? '$';
    if (n === null) return { value: DASH, tone: 'neutral' };
    return {
      value: `${symbol}${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`,
      tone: 'neutral',
    };
  },
  percent(value) {
    const n = toNumber(value);
    if (n === null) return { value: DASH, tone: 'neutral' };
    // Values are 0..1 ratios; show as a whole-ish percent.
    const pct = n * 100;
    const text = pct >= 10 || pct === 0 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
    return { value: text, tone: 'neutral' };
  },
  text(value) {
    if (value === null || value === undefined || value === '') return { value: DASH, tone: 'neutral' };
    return { value: String(value), tone: 'neutral' };
  },
};

/**
 * Format one metric value for a descriptor. Reads the descriptor's DATA format
 * hint, dispatches through the registry, and falls back to text for an unknown
 * hint. This is the `formatValue` the surfaces pass to RecordMetricRow.
 */
export function formatMetric(
  value: unknown,
  descriptor: VisualDatabaseFieldDescriptor,
  options: MetricFormatOptions = {},
): RecordMetricFormat {
  const hint = metricFormatHint(descriptor);
  const formatter = METRIC_FORMATTERS[hint] ?? METRIC_FORMATTERS.text;
  return formatter(value, options);
}
