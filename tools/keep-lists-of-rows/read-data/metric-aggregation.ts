//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure aggregation for the metric view_kind. A metric card names a value spec
// (an aggregation op plus a field), and this leaf reduces the view's record-set
// to a single number, formats it, grades its tone, and, when configured,
// computes a delta against a baseline. It reads each record's value through the
// SAME generic `extractFieldValue` the table/list views use, so a metric over a
// derived cell-expression field reuses that computed value with zero special
// casing.
//
// The reducer set, the formatter set, and the tone are DATA-selected through
// maps keyed by the spec's `op` / `format` / tone strings. Adding a reducer or a
// formatter is one map entry, so the caller never branches on the op in code and
// unknown keys degrade instead of throwing. This is the value/delta math half of
// the L088 metric decomposition (pixels live in packages/ui/show; the thin
// view_kind wiring lives in the surface).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. PURE: no React, no I/O, no data reads beyond the passed record-set + model.
// 2. NEVER THROWS on bad data. An unknown op, a missing field, or a non-numeric
//    value resolves to a null value plus an honest `error` string, never a crash.
// 3. Reducers, formatters, and tones are DATA-keyed maps; the reduce is a plain
//    array fold, not a new expression engine.
// 4. A count over zero records is a valid reading (0), not an empty state.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import {
  extractFieldValue,
  type VisualDatabaseMetricDescriptor,
  type VisualDatabaseMetricValueSpec,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
} from './visual-database';

/** The glanceable "no reading" glyph the shared ui/show atoms use for an absent
 *  value. Built from its code point so this source carries no literal em-dash. */
const NO_VALUE = String.fromCharCode(0x2014);

/** The four tone grades a metric value can carry. Shared with the ui/show atoms
 *  (score-ring uses all four; metric-row maps them down to its own set). */
export type MetricTone = 'positive' | 'caution' | 'critical' | 'neutral';

const METRIC_TONES: ReadonlySet<string> = new Set<MetricTone>([
  'positive',
  'caution',
  'critical',
  'neutral',
]);

function normalizeTone(tone: string | undefined): MetricTone {
  return tone !== undefined && METRIC_TONES.has(tone) ? (tone as MetricTone) : 'neutral';
}

/** A reducer folds the extracted numeric values (and the raw record count, for
 *  `count`) into one number, or null when the reduction is undefined (e.g. an
 *  average of zero values). */
export type MetricReducer = (values: readonly number[], recordCount: number) => number | null;

/** DATA-keyed reducer map. Add an aggregation = add one entry here; the view
 *  renderer never names an op. Unknown ops resolve to an honest error, so the
 *  set is open, not a closed enum baked into a branch. */
export const METRIC_REDUCERS: Record<string, MetricReducer> = {
  count: (_values, recordCount) => recordCount,
  'count-values': (values) => values.length,
  sum: (values) => values.reduce((total, value) => total + value, 0),
  average: (values) => (values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : null),
  min: (values) => (values.length > 0 ? Math.min(...values) : null),
  max: (values) => (values.length > 0 ? Math.max(...values) : null),
  latest: (values) => (values.length > 0 ? values[values.length - 1] : null),
  first: (values) => (values.length > 0 ? values[0] : null),
};

/** A formatter turns a finite number into its display string. */
export type MetricFormatter = (value: number) => string;

/** DATA-keyed formatter map. Unknown keys fall back to `decimal`. */
export const METRIC_FORMATTERS: Record<string, MetricFormatter> = {
  integer: (value) => Math.round(value).toLocaleString('en-US'),
  decimal: (value) => value.toLocaleString('en-US', { maximumFractionDigits: 2 }),
  currency: (value) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }),
  percent: (value) => `${Math.round(value * 100)}%`,
};

/** Coerce a raw field value to a finite number, or null if it is not numeric.
 *  Numeric strings with currency/percent/thousands ornaments coerce (a "$1,200"
 *  cell reads as 1200); anything else is null and counted as non-numeric. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const stripped = trimmed.replace(/[$,\s%]/g, '');
    const parsed = Number(stripped);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** The formatted, tone-graded result of one metric value spec. */
export interface MetricComputation {
  /** The reduced number, or null when the reduction is undefined / errored. */
  value: number | null;
  /** The display string (the absent-value glyph when value is null). */
  displayValue: string;
  tone: MetricTone;
  /** An honest one-line reason the value is null / partial (unknown op, missing
   *  field, non-numeric values). Absent when the reading is clean. */
  error?: string;
  /** A comparison against the spec's baseline, when a delta is configured. */
  delta?: {
    value: number;
    direction: 'up' | 'down' | 'flat';
    displayValue: string;
    label?: string;
  };
}

/** Format a (possibly null) number through the DATA-selected formatter. */
export function formatMetricNumber(value: number | null, format: string | undefined): string {
  if (value === null) return NO_VALUE;
  const formatter = (format !== undefined && METRIC_FORMATTERS[format]) || METRIC_FORMATTERS.decimal;
  return formatter(value);
}

function resolveTone(value: number | null, spec: VisualDatabaseMetricValueSpec): MetricTone {
  if (value !== null && spec.toneThresholds) {
    for (const threshold of spec.toneThresholds) {
      const aboveMin = threshold.min === undefined || value >= threshold.min;
      const belowMax = threshold.max === undefined || value <= threshold.max;
      if (aboveMin && belowMax) return normalizeTone(threshold.tone);
    }
  }
  return normalizeTone(spec.tone);
}

function computeDelta(
  value: number | null,
  spec: VisualDatabaseMetricValueSpec,
): MetricComputation['delta'] {
  if (!spec.delta || value === null) return undefined;
  const diff = value - spec.delta.baseline;
  const direction: 'up' | 'down' | 'flat' = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  return {
    value: diff,
    direction,
    displayValue: formatMetricNumber(Math.abs(diff), spec.format),
    ...(spec.delta.label !== undefined ? { label: spec.delta.label } : {}),
  };
}

/** Reduce the record-set to one metric value spec's reading. */
export function computeMetricValue(
  spec: VisualDatabaseMetricValueSpec,
  records: readonly VisualDatabaseRecord[],
  model: VisualDatabaseModel,
): MetricComputation {
  const reducer = METRIC_REDUCERS[spec.aggregation.op];
  if (!reducer) {
    return {
      value: null,
      displayValue: NO_VALUE,
      tone: normalizeTone(spec.tone),
      error: `Unknown aggregation "${spec.aggregation.op}".`,
    };
  }

  const descriptor = spec.aggregation.fieldId
    ? model.fields.find((field) => field.id === spec.aggregation.fieldId) ?? null
    : null;

  let error: string | undefined;
  const numbers: number[] = [];

  if (spec.aggregation.fieldId && !descriptor) {
    error = `No field "${spec.aggregation.fieldId}".`;
  } else if (descriptor) {
    let nonNumeric = 0;
    for (const record of records) {
      const raw = extractFieldValue(record, descriptor);
      if (raw === null || raw === undefined) continue;
      const parsed = toFiniteNumber(raw);
      if (parsed === null) nonNumeric += 1;
      else numbers.push(parsed);
    }
    // Only surface a data-quality error when it actually starved the reduction:
    // `count` never reads a field, and a partial field is still a real reading.
    if (nonNumeric > 0 && numbers.length === 0 && spec.aggregation.op !== 'count') {
      error = `${nonNumeric} value${nonNumeric === 1 ? '' : 's'} could not be read as a number.`;
    }
  }

  const value = reducer(numbers, records.length);
  const delta = computeDelta(value, spec);
  return {
    value,
    displayValue: formatMetricNumber(value, spec.format),
    tone: resolveTone(value, spec),
    ...(error !== undefined ? { error } : {}),
    ...(delta ? { delta } : {}),
  };
}

/** Reduce every value spec of a metric card, in order. */
export function computeMetricValues(
  metric: VisualDatabaseMetricDescriptor,
  records: readonly VisualDatabaseRecord[],
  model: VisualDatabaseModel,
): readonly MetricComputation[] {
  return metric.values.map((spec) => computeMetricValue(spec, records, model));
}

/** Map a four-grade metric tone down to the metric-row cell's three-grade tone.
 *  caution has no distinct metric-row cell tone, so it reads neutral there. */
export function metricRowTone(tone: MetricTone): 'neutral' | 'success' | 'error' {
  if (tone === 'positive') return 'success';
  if (tone === 'critical') return 'error';
  return 'neutral';
}
