// parts/ui/show/chart/chart-from-records.ts
//
// PURPOSE
//   Makes what a chart shows (ChartData) from records and a ChartPlacement DATA row: which field's number is read, which
//   field groups the records, which formula reduces each group, and over which time bucket. The same function serves a
//   list's chart view (values read through the list's own fields), a screen's charts and a chart placed anywhere
//   (values read by path from the answer), so every chart of records is the same few DATA fields.
//   Also holds the open maps the placement names into: formulas, time buckets, value readers and derivations.
//   A placement can read several numbers at once (`series`), cut one number into ranges (`bins`, a histogram) and add
//   lines worked out from the numbers it drew (`derive`: a moving average, a running total, change since the start).
//
// Adapted from Spectrum UI (https://github.com/arihantcodes/spectrum-ui, Apache-2.0, commit acdc998c): registry/charts/histogram-chart.tsx (bins), chart-engine.ts (moving average, running total, change); changes: the same maths as DATA over any records, in open maps.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No field, list or service is named here: the placement names fields, `readField` reads them.
//   2. Formulas, buckets and value readers are maps; a placement naming one the map lacks gets the default (sum, day,
//      number), never a crash. Registering an entry adds a member everywhere at once.
//   3. A time axis is continuous: every bucket between the first and last record is a slot, so a quiet day reads as
//      nothing counted (0 for a count or sum, a gap for an average), never as a missing day the eye skips over.
//   4. A plain date (YYYY-MM-DD) is that day in the person's own time zone, never UTC midnight read back a day early.

import type { FieldDescriptor } from '../record-views/record-views';
import type { ChartData, ChartDerivationRow, ChartLine, ChartLineRow, ChartPlacement, ChartRange, ChartSeries, ChartSlot } from './chart-types';

export type ValueOf = (record: unknown, field: string) => unknown;

// ---------------------------------------------------------------------------------------------------------------------
// Formulas: how a group's numbers become one number.
// ---------------------------------------------------------------------------------------------------------------------

/** `counts`: it counts records and reads no number. `additive`: the results of several slots add up to something that means a total (a sum, a count); false for a formula that reads a level (average, most, least, first, latest), whose chart headline is the latest slot, never a sum. Left out it is additive, so a registered formula that reads a level says `additive: false`. */
export type Formula = { label: string; reduce: (values: number[], count: number) => number | null; zero: number | null; counts?: boolean; additive?: boolean };
const FORMULAS = new Map<string, Formula>([
  ['sum', { label: 'Total', reduce: values => values.reduce((sum, value) => sum + value, 0), zero: 0 }],
  ['count', { label: 'Count', reduce: (_values, count) => count, zero: 0, counts: true }],
  ['average', { label: 'Average', reduce: values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null), zero: null, additive: false }],
  ['most', { label: 'Most', reduce: values => (values.length ? Math.max(...values) : null), zero: null, additive: false }],
  ['least', { label: 'Least', reduce: values => (values.length ? Math.min(...values) : null), zero: null, additive: false }],
  ['first', { label: 'First', reduce: values => (values.length ? values[0] : null), zero: null, additive: false }],
  ['latest', { label: 'Latest', reduce: values => (values.length ? values[values.length - 1] : null), zero: null, additive: false }],
]);
export const registerChartFormula = (id: string, formula: Formula) => { FORMULAS.set(id, formula); };
export const chartFormulas = () => [...FORMULAS].map(([id, formula]) => ({ id, label: formula.label, counts: Boolean(formula.counts), additive: formula.additive !== false }));
/** Whether a formula's slot results add up to a meaningful total (sum, count). A missing or unknown id reads as the default (sum or count), which does. */
export const formulaAdditive = (id: string | undefined): boolean => (id === undefined ? true : (FORMULAS.get(id) ?? FORMULAS.get('sum')!).additive !== false);
export const formulaOf = (id: string | undefined, counting: boolean) => FORMULAS.get(id ?? (counting ? 'count' : 'sum')) ?? FORMULAS.get('sum')!;

// ---------------------------------------------------------------------------------------------------------------------
// Time buckets: where a moment's bucket starts, the next one, and how it is named at a glance.
// ---------------------------------------------------------------------------------------------------------------------

export type Bucket = { label: string; start: (t: number) => number; next: (t: number) => number; name: (t: number) => string; long: (t: number) => string; finer?: string };
const at = (t: number) => new Date(t);
const BUCKETS = new Map<string, Bucket>([
  ['hour', { label: 'Hour', start: t => { const d = at(t); d.setMinutes(0, 0, 0); return d.getTime(); }, next: t => t + 3_600_000,
    name: t => at(t).toLocaleTimeString(undefined, { hour: 'numeric' }), long: t => at(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' }) }],
  ['day', { label: 'Day', finer: 'hour', start: t => { const d = at(t); d.setHours(0, 0, 0, 0); return d.getTime(); }, next: t => { const d = at(t); d.setDate(d.getDate() + 1); return d.getTime(); },
    name: t => at(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), long: t => at(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) }],
  ['week', { label: 'Week', finer: 'day', start: t => { const d = at(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }, next: t => { const d = at(t); d.setDate(d.getDate() + 7); return d.getTime(); },
    name: t => at(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), long: t => `Week of ${at(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` }],
  ['month', { label: 'Month', finer: 'week', start: t => { const d = at(t); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); }, next: t => { const d = at(t); d.setMonth(d.getMonth() + 1); return d.getTime(); },
    name: t => at(t).toLocaleDateString(undefined, { month: 'short' }), long: t => at(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }],
]);
export const registerChartBucket = (id: string, bucket: Bucket) => { BUCKETS.set(id, bucket); };
export const chartBuckets = () => [...BUCKETS].map(([id, bucket]) => ({ id, label: bucket.label, finer: bucket.finer }));
export const bucketOf = (id: string | undefined) => BUCKETS.get(id ?? 'day') ?? BUCKETS.get('day')!;

/** A moment from a record value: epoch ms, an ISO time, or a plain date read as that day in the person's own zone. */
export function momentOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (plain) return new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3])).getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Value readers: how a number reads in full (tooltips) and short (axis ticks).
// ---------------------------------------------------------------------------------------------------------------------

export type ValueReader = { full: (value: number) => string; short: (value: number) => string };
const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
function bytesWords(value: number, digits: number): string {
  let size = Math.abs(value), unit = 0;
  while (size >= 1000 && unit < BYTE_UNITS.length - 1) { size /= 1000; unit += 1; }
  return `${value < 0 ? '-' : ''}${size.toFixed(unit && size < 10 ? digits : 0)} ${BYTE_UNITS[unit]}`;
}
const VALUE_READERS = new Map<string, ValueReader>([
  ['number', { full: value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value), short: compact }],
  ['count', { full: value => Math.round(value).toLocaleString(), short: compact }],
  ['money', {
    full: value => `${value < 0 ? '-' : ''}$${Math.abs(value) < 10 ? Math.abs(value).toFixed(2) : Math.round(Math.abs(value)).toLocaleString()}`,
    short: value => (Math.abs(value) < 10 && value % 1 ? `$${value.toFixed(value < 1 ? 2 : 1)}` : `$${compact(value)}`),
  }],
  ['seconds', {
    full: value => (value < 90 ? `${Math.round(value)}s` : value < 5400 ? `${Math.round(value / 60)} min` : value < 172800 ? `${Math.round(value / 3600)} h` : `${Math.round(value / 86400)} d`),
    short: value => (value < 90 ? `${Math.round(value)}s` : value < 5400 ? `${Math.round(value / 60)}m` : value < 172800 ? `${Math.round(value / 3600)}h` : `${Math.round(value / 86400)}d`),
  }],
  ['percent', { full: value => `${Math.round(value)}%`, short: value => `${Math.round(value)}%` }],
  ['bytes', { full: value => bytesWords(value, 1), short: value => bytesWords(value, 0) }],
]);
export const registerChartValueReader = (id: string, reader: ValueReader) => { VALUE_READERS.set(id, reader); };
export const valueReader = (id: string | undefined): ValueReader => VALUE_READERS.get(id ?? 'number') ?? VALUE_READERS.get('number')!;

// ---------------------------------------------------------------------------------------------------------------------
// Derivations: a line worked out from the numbers already drawn.
// ---------------------------------------------------------------------------------------------------------------------

type Values = (number | null)[];
/**
 * `label` names the line; `unit` is the value kind of the result when it is not the source's (a percent): such a
 * result replaces the numbers it came from, so one chart never mixes two units on one axis. `derive` gets the source's
 * values and the window; `all` is every series drawn before, for a share of the whole.
 */
export type Derivation = {
  label: (options: { window: number; unit: string }) => string;
  unit?: string;
  /** True when the result is on a scale of its own (an index from 0 to 100): it replaces the numbers it came from, as a change of unit does. */
  replaces?: boolean;
  derive: (values: Values, options: { window: number; all: Values[] }) => Values;
};
const filled = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
/** Each value pulled toward the last: the weight of the newest is 2 / (window + 1). A gap is skipped, the average carries over it. */
const exponential = (values: Values, window: number): Values => {
  const weight = 2 / (window + 1);
  let last: number | null = null;
  return values.map(value => {
    if (!filled(value)) return last;
    last = last === null ? value : value * weight + last * (1 - weight);
    return last;
  });
};
const DERIVATIONS = new Map<string, Derivation>([
  ['moving-average', {
    label: ({ window, unit }) => `${window}-${unit} average`,
    derive: (values, { window }) => values.map((_, index) => {
      const near = values.slice(Math.max(0, index - window + 1), index + 1).filter(filled);
      return near.length ? near.reduce((sum, value) => sum + value, 0) / near.length : null;
    }),
  }],
  ['exponential-average', {
    label: ({ window, unit }) => `${window}-${unit} weighted average`,
    derive: (values, { window }) => exponential(values, window),
  }],
  ['rsi', {
    // Relative strength index (Wilder): how much of the recent movement was upward, from 0 to 100; `window` is the period (14 is usual).
    label: ({ window }) => `strength index (${window})`, unit: 'percent', replaces: true,
    derive: (values, { window }) => {
      const out: Values = values.map(() => null);
      const moves: { at: number; change: number }[] = [];
      let before: number | null = null;
      values.forEach((value, at) => {
        if (!filled(value)) return;
        if (before !== null) moves.push({ at, change: value - before });
        before = value;
      });
      if (moves.length < window) return out;
      const index = (gain: number, loss: number) => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
      let gain = 0, loss = 0;
      for (let i = 0; i < window; i += 1) { gain += Math.max(0, moves[i].change); loss += Math.max(0, -moves[i].change); }
      gain /= window; loss /= window;
      out[moves[window - 1].at] = index(gain, loss);
      for (let i = window; i < moves.length; i += 1) {
        gain = (gain * (window - 1) + Math.max(0, moves[i].change)) / window;
        loss = (loss * (window - 1) + Math.max(0, -moves[i].change)) / window;
        out[moves[i].at] = index(gain, loss);
      }
      return out;
    },
  }],
  ['macd', {
    // The 12-slot weighted average minus the 26-slot one; add an exponential-average of it (window 9) for the signal line.
    label: () => 'MACD', replaces: true,
    derive: values => { const fast = exponential(values, 12), slow = exponential(values, 26); return values.map((_, at) => (filled(fast[at]) && filled(slow[at]) ? fast[at] - slow[at] : null)); },
  }],
  ['running-total', {
    label: () => 'running total',
    derive: values => { let total = 0; return values.map(value => (filled(value) ? (total += value) : null)); },
  }],
  ['change-percent', {
    label: () => 'change since the start', unit: 'percent',
    derive: values => {
      const first = values.find(filled);
      return values.map(value => (filled(value) && first !== undefined && first !== 0 ? ((value - first) / Math.abs(first)) * 100 : null));
    },
  }],
  ['difference', {
    label: ({ unit }) => `change from the last ${unit}`,
    derive: values => values.map((value, index) => (index > 0 && filled(value) && filled(values[index - 1]) ? value - (values[index - 1] as number) : null)),
  }],
  ['share', {
    label: () => 'share', unit: 'percent',
    derive: (values, { all }) => {
      // Of everything drawn at that slot; with one series drawn, of everything it drew across the slots.
      const whole = all.length > 1 ? null : values.filter(filled).reduce((sum, value) => sum + value, 0);
      return values.map((value, index) => {
        const total = whole ?? all.map(each => each[index]).filter(filled).reduce((sum, one) => sum + one, 0);
        return filled(value) && total > 0 ? (value / total) * 100 : null;
      });
    },
  }],
]);
export const registerChartDerivation = (id: string, derivation: Derivation) => { DERIVATIONS.set(id, derivation); };
export const chartDerivations = () => [...DERIVATIONS].map(([id, derivation]) => ({ id, label: derivation.label({ window: 7, unit: 'day' }), unit: derivation.unit }));

/** A derivation run over a series; `from: 'end'` reads it from the last slot back, so a total grows outward from the end. */
const derivedValues = (entry: Derivation, values: Values, options: { window: number; all: Values[] }, row: ChartDerivationRow): Values =>
  row.from === 'end' ? entry.derive([...values].reverse(), options).reverse() : entry.derive(values, options);

const derivationWindow = (row: ChartDerivationRow) => (typeof row.window === 'number' && row.window >= 1 ? Math.floor(row.window) : 7);
const sourceOf = (pool: readonly ChartSeries[], row: ChartDerivationRow) =>
  (row.of ? pool.find(series => series.id === row.of || series.role === row.of || series.label === row.of) : undefined) ?? pool.find(series => !paneOf(series)) ?? pool[0];

/** The rows that say `instead`: each series they name now holds the worked-out numbers, with the id, role, tone and mark it had. */
function drawnInPlace(data: ChartData, rows: readonly ChartDerivationRow[]): ChartData {
  let series = data.series;
  let kind = data.value_kind;
  for (const row of rows) {
    const entry = row?.instead && typeof row.kind === 'string' ? DERIVATIONS.get(row.kind) : undefined;
    const source = entry ? sourceOf(series, row) : undefined;
    if (!entry || !source) continue;
    const values = derivedValues(entry, source.values, { window: derivationWindow(row), all: series.filter(one => !paneOf(one)).map(one => one.values) }, row);
    series = series.map(one => (one === source ? { ...one, values } : one));
    if (entry.unit) kind = entry.unit;
  }
  return series === data.series ? data : { ...data, series, value_kind: kind };
}

/** The data with the lines its derivations name added (or, for a change of unit, drawn in place of the numbers). A kind nobody registered is skipped. */
function withDerivations(given: ChartData, every: readonly ChartDerivationRow[]): ChartData {
  const data = every.some(row => row?.instead) ? drawnInPlace(given, every) : given;
  const rows = every.filter(row => !row?.instead);
  const bucketUnit = data.bucket ? bucketOf(data.bucket).label.toLowerCase() : 'slot';
  const all = data.series.filter(series => !paneOf(series)).map(series => series.values);
  const added: { series: ChartSeries; unit: string | undefined; replaces: boolean }[] = [];
  rows.forEach((row, at) => {
    const entry = typeof row?.kind === 'string' ? DERIVATIONS.get(row.kind) : undefined;
    if (!entry) return;
    const pool = [...data.series, ...added.map(each => each.series)];
    const source = sourceOf(pool, row);
    if (!source) return;
    const window = derivationWindow(row);
    // A line made from one already replaced onto its own scale stays on that scale.
    const parent = added.find(each => each.series === source);
    const replaces = Boolean(entry.replaces || (entry.unit && entry.unit !== data.value_kind) || parent?.replaces);
    const unit = entry.unit ?? parent?.unit;
    added.push({
      unit, replaces,
      series: {
        id: row.id ?? `${row.kind}:${source.id}:${at}`, label: row.label ?? `${source.label}, ${entry.label({ window, unit: bucketUnit })}`, slot: pool.length,
        values: derivedValues(entry, source.values, { window, all }, row),
        ...(replaces ? {} : { draw: row.draw ?? 'line', dashed: row.dashed ?? true }),
      },
    });
  });
  if (!added.length) return data;
  const swap = added.find(each => each.replaces);
  const finalUnit = swap ? swap.unit ?? data.value_kind : data.value_kind;
  return {
    ...data,
    value_kind: finalUnit,
    // On a scale of its own the first line stands in for the data; the lines made from it (a signal line) are drawn beside it, dashed.
    series: swap
      ? added.filter(each => each.replaces && (each.unit ?? data.value_kind) === finalUnit).map(each => (each === swap ? each.series : { ...each.series, draw: each.series.draw ?? 'line', dashed: each.series.dashed ?? true, derived: true }))
      : [...data.series, ...added.map(each => ({ ...each.series, derived: true }))],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Placement -> ChartData
// ---------------------------------------------------------------------------------------------------------------------

export const readPath = (from: unknown, path: readonly string[] | undefined): unknown =>
  (path ?? []).reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), from);
export const valueByPath: ValueOf = (record, field) => readPath(record, [field]);

const numberOf = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
};
const words = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.map(words).filter(Boolean).join(', ');
  if (typeof value === 'object') return String((value as Record<string, unknown>).label ?? (value as Record<string, unknown>).title ?? (value as Record<string, unknown>).id ?? '');
  return String(value);
};
const kept = (row: unknown, where?: { path: string[]; one_of: unknown[] }) => !where || where.one_of.some(one => one === readPath(row, where.path));

// ---------------------------------------------------------------------------------------------------------------------
// Orders: how the groups of a category chart are laid out.
// ---------------------------------------------------------------------------------------------------------------------

/** `compare` lays two groups out; `at` (when the order reads a number) is a group's position on a numeric axis, null when it holds none. */
export type ChartOrder = { compare: (a: { group: string; total: number }, b: { group: string; total: number }) => number; at?: (group: string) => number | null };
const positionOf = (group: string): number | null => numberOf(group);
const byPosition = (sign: 1 | -1): ChartOrder['compare'] => (a, b) => {
  const x = positionOf(a.group), y = positionOf(b.group);
  return x === null || y === null ? Number(x === null) - Number(y === null) : sign * (x - y);
};
const ORDERS = new Map<string, ChartOrder>([
  ['total', { compare: (a, b) => b.total - a.total }],
  ['number', { compare: byPosition(1), at: positionOf }],
  ['number-descending', { compare: byPosition(-1), at: positionOf }],
  ['name', { compare: (a, b) => a.group.localeCompare(b.group) }],
]);
/** Adds a way to lay groups out (a price ladder, a calendar order). Registering an id again replaces it. */
export const registerChartOrder = (id: string, order: ChartOrder) => { ORDERS.set(id, order); };
export const chartOrders = () => [...ORDERS.keys()];

/**
 * The middle of a numeric axis: a number as given, or 'between' = halfway between where the first series ends and the
 * second begins (a book's best bid and best ask), read from the slots' `at`; null when there is no such middle.
 */
function midOf(data: ChartData, mid: unknown): number | null {
  if (typeof mid === 'number' && Number.isFinite(mid)) return mid;
  if (mid !== 'between' || data.slots.some(slot => typeof slot.at !== 'number')) return null;
  const spans = data.series.slice(0, 2).map(series => {
    const found = series.values.flatMap((value, index) => (typeof value === 'number' && Number.isFinite(value) ? [data.slots[index].at as number] : []));
    return found.length ? { low: Math.min(...found), high: Math.max(...found) } : null;
  });
  const [a, b] = spans;
  if (!a || !b) return null;
  if (a.high <= b.low) return (a.high + b.low) / 2;
  if (b.high <= a.low) return (b.high + a.low) / 2;
  return null;
}

export type ChartInput = {
  placement: ChartPlacement;
  /** The records, or the whole answer when the placement names `records_path`. */
  records: readonly unknown[];
  /** The answer the records came from, for reference lines read from it. */
  answer?: unknown;
  readField?: ValueOf;
  /** How a group value is named (a tag's label), when the list says. */
  groupLabel?: (value: string) => string;
  /** The bucket the person chose (drill down or roll up), over the placement's own. */
  bucket?: string;
  /** Only records from this moment until `until` (a drilled-into slot). */
  since?: number; until?: number;
  /** The id of the placement's `ranges` choice the person made (over the placement's own `range`): only the last stretch of time before the latest record. */
  range?: string;
  /** The words for the groups beyond the limit. */
  otherLabel?: string;
};

/**
 * The pane a series is drawn in: undefined for the main plot (no `pane`, or 'main'), else the pane's name (volume). A role
 * the mark lists as a pane role (candlestick lists volume) names a pane of its own when the series says none.
 */
export function paneOf(series: { pane?: string; role?: string }, paneRoles?: readonly string[]): string | undefined {
  if (typeof series.pane === 'string' && series.pane) return series.pane === 'main' ? undefined : series.pane;
  return series.role && paneRoles?.includes(series.role) ? series.role : undefined;
}

/** The choices a time chart offers when its placement names none (a list's chart view): the last month, three, six, the year so far, a year, everything. */
export const DEFAULT_RANGES: ChartRange[] = [
  { id: '1m', label: '1M', since: { months: 1 } }, { id: '3m', label: '3M', since: { months: 3 } }, { id: '6m', label: '6M', since: { months: 6 } },
  { id: 'ytd', label: 'YTD', since: 'year-start' }, { id: '1y', label: '1Y', since: { years: 1 } }, { id: 'all', label: 'All' },
];

/** The moment a chosen range starts, counting back from `latest`; null when no range is chosen, it names no length, or nothing is dated. */
export function rangeStart(ranges: ChartRange[] | undefined, chosen: string | undefined, latest: number | null): number | null {
  const range = Array.isArray(ranges) ? ranges.find(one => one && one.id === chosen) : undefined;
  if (!range || latest === null) return null;
  const at = new Date(latest);
  if (range.since === 'year-start') return new Date(at.getFullYear(), 0, 1).getTime();
  const since = range.since && typeof range.since === 'object' ? range.since : {};
  const part = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  const days = part(range.days) + part(since.days) + 7 * part(since.weeks);
  if (!range.since && !range.days) return null;
  at.setFullYear(at.getFullYear() - part(since.years));
  at.setMonth(at.getMonth() - part(since.months));
  at.setDate(at.getDate() - days);
  return at.getTime();
}

/** What a placement shows for these records. */
export function chartFromRecords(input: ChartInput): ChartData {
  const { placement, answer } = input;
  const readField = input.readField ?? valueByPath;
  const source = placement.records_path ? readPath(answer, placement.records_path) : input.records;
  const sinceValue = placement.over?.since_path ? momentOf(readPath(answer, placement.over.since_path)) : null;
  const throughRaw = placement.over?.through_path ? readPath(answer, placement.over.through_path) : null;
  const throughValue = momentOf(throughRaw);
  const throughEnd = throughValue === null ? null : typeof throughRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(throughRaw)
    ? bucketOf('day').next(throughValue) - 1 : throughValue;
  const records = (Array.isArray(source) ? source : []).filter(row => {
    if (!kept(row, placement.where)) return false;
    if (!placement.over?.since_path && !placement.over?.through_path) return true;
    if ((placement.over.since_path && sinceValue === null) || (placement.over.through_path && throughValue === null)) return false;
    const at = momentOf(readField(row, placement.over.field));
    return at !== null && (sinceValue === null || at >= sinceValue) && (throughEnd === null || at <= throughEnd);
  });
  const counting = !placement.reading;
  const formula = formulaOf(placement.formula, counting);
  const groupOf = (record: unknown) => (placement.group ? words(readField(record, placement.group)) : '');
  // One number a record gives, and how a group of records becomes one number of it.
  const measureOf = (reading: string | undefined, formulaId: string | undefined) => {
    const each = formulaOf(formulaId, !reading);
    const read = (record: unknown) => (reading ? numberOf(readField(record, reading)) : 1);
    const reduce = (rows: unknown[]): number | null => (rows.length ? each.reduce(rows.map(read).filter((value): value is number => value !== null), rows.length) : each.zero);
    return { read, reduce };
  };
  const main = measureOf(placement.reading, placement.formula);
  // Several readings at once: each is a series with its own formula, mark and role; they replace splitting by `group`.
  const measures = (Array.isArray(placement.series) ? placement.series : []).filter(row => row && typeof row.reading === 'string')
    .map((row, index) => ({ row, index, ...measureOf(row.reading, row.formula) }));
  const readingOf = measures.length ? measures[0].read : main.read;
  const label = placement.title ?? formula.label;
  const seriesOf = (rowsAt: unknown[][]): ChartSeries[] => measures.map(({ row, index, reduce }) => ({
    id: row.role ?? `${row.reading}:${index}`, label: row.label ?? row.reading, slot: index,
    values: rowsAt.map(rows => {
      const mine = row.where ? rows.filter(one => kept(one, row.where)) : rows;
      return row.where && !mine.length ? null : reduce(mine);
    }),
    ...(row.curve ? { curve: row.curve } : {}), ...(row.bar ? { bar: row.bar } : {}),
    ...(row.draw ? { draw: row.draw } : {}), ...(row.role ? { role: row.role } : {}), ...(row.tone ? { tone: row.tone } : {}), ...(row.dashed ? { dashed: true } : {}), ...(row.pane ? { pane: row.pane } : {}),
  }));

  // Groups ordered by their total, largest first; beyond the limit they are folded into one.
  const totals = new Map<string, number>();
  for (const record of records) {
    const group = groupOf(record);
    totals.set(group, (totals.get(group) ?? 0) + Math.abs(readingOf(record) ?? 0));
  }
  const ordered = [...totals].sort((a, b) => b[1] - a[1]).map(([group]) => group);
  const limit = placement.limit && placement.limit > 0 ? placement.limit : ordered.length;
  const shownGroups = ordered.length > limit ? ordered.slice(0, Math.max(1, limit - 1)) : ordered;
  const other = input.otherLabel ?? 'Other';
  const folded = (group: string) => (shownGroups.includes(group) ? group : other);
  // A named order lays the groups out afresh (a price ladder from the lowest price up); the folded "Other" stays last.
  const order = placement.order ? ORDERS.get(placement.order) : undefined;
  const arranged = order ? [...shownGroups].map(group => ({ group, total: totals.get(group) ?? 0 })).sort(order.compare).map(each => each.group) : shownGroups;
  const groups = ordered.length > limit ? [...arranged, other] : arranged;
  const nameOf = (group: string) => (group === other && ordered.length > limit ? other : group ? (input.groupLabel?.(group) ?? group) : '');

  const reduce = main.reduce;

  let data: ChartData;
  if (placement.bins) {
    // Slots are ranges of the reading; each counts the records inside it (or reduces its own series' readings).
    const { count: wanted, width: step } = placement.bins;
    const found = placement.reading ? records.flatMap(record => { const value = numberOf(readField(record, placement.reading!)); return value === null ? [] : [{ record, value }]; }) : [];
    const low = found.length ? Math.min(...found.map(each => each.value)) : 0;
    const high = found.length ? Math.max(...found.map(each => each.value)) : 0;
    let start = low, width = 1, count = 0;
    if (found.length && typeof step === 'number' && step > 0) { width = step; start = Math.floor(low / width) * width; count = Math.floor((high - start) / width) + 1; }
    else if (found.length) {
      count = typeof wanted === 'number' && wanted >= 1 ? Math.floor(wanted) : Math.min(20, Math.max(5, Math.ceil(Math.sqrt(found.length))));
      width = high > low ? (high - low) / count : 1;
      if (high === low) count = 1;
    }
    count = Math.min(count, 200);
    const inBin: unknown[][] = Array.from({ length: count }, () => []);
    for (const { record, value } of found) inBin[Math.min(count - 1, Math.max(0, Math.floor((value - start) / width)))].push(record);
    const reader = valueReader(measures.length ? 'number' : placement.value_kind);
    // "200 ms" to "300 ms" reads "200–300 ms": a unit both ends share is said once.
    const range = (from: number, to: number) => {
      const a = reader.short(from), b = reader.short(to);
      const suffix = /[^\d.,]+$/.exec(b)?.[0];
      return `${suffix && a.endsWith(suffix) ? a.slice(0, -suffix.length) : a}\u2013${b}`;
    };
    const slots: ChartSlot[] = inBin.map((_, at) => ({ key: String(start + at * width), label: range(start + at * width, start + (at + 1) * width) }));
    const series = measures.length ? seriesOf(inBin) : [{ id: 'count', label: placement.title ?? formula.label, slot: 0, values: inBin.map(rows => rows.length) }];
    data = { slots, series };
  } else if (placement.over) {
    const bucketId = input.bucket ?? placement.over.bucket ?? 'day';
    const bucket = bucketOf(bucketId);
    const dated = records.flatMap(record => {
      const t = momentOf(readField(record, placement.over!.field));
      return t === null ? [] : [{ record, t }];
    }).sort((a, b) => a.t - b.t);
    // The chosen range counts back from the latest record, so "1M" is always the last month of what there is.
    const back = rangeStart(placement.ranges, input.range ?? placement.range, dated.length ? dated[dated.length - 1].t : null);
    const from = Math.max(input.since ?? -Infinity, back ?? -Infinity);
    const timed = dated.filter(({ t }) => t >= from && (input.until === undefined || t < input.until));
    const slots: ChartSlot[] = [];
    if (timed.length || (sinceValue !== null && throughValue !== null)) {
      const first = bucket.start(Math.max(from, sinceValue ?? timed[0].t));
      const last = Math.min(input.until === undefined ? Infinity : input.until - 1, throughEnd ?? timed[timed.length - 1].t);
      for (let t = first, guard = 0; t <= last && guard < 2000; t = bucket.next(t), guard += 1) slots.push({ key: String(t), label: bucket.name(t), t, until: bucket.next(t) });
    }
    if (placement.partial_last && slots.length && input.until === undefined) slots[slots.length - 1].partial = true;
    const indexOf = (t: number) => { const start = bucket.start(t); return slots.findIndex(slot => slot.t === start); };
    const byGroup = new Map<string, unknown[][]>((measures.length ? [''] : groups).map(group => [group, slots.map(() => [])]));
    for (const { record, t } of timed) {
      const index = indexOf(t);
      if (index < 0) continue;
      byGroup.get(measures.length ? '' : folded(groupOf(record)))?.[index].push(record);
    }
    const series: ChartSeries[] = measures.length ? seriesOf(byGroup.get('') ?? slots.map(() => [])) : groups.map((group, index) => ({
      id: group || 'all', label: nameOf(group) || label, slot: index,
      values: (byGroup.get(group) ?? []).map(rows => reduce(rows)),
    }));
    data = { slots, series, bucket: bucketId };
  } else {
    const rowsByGroup = new Map<string, unknown[]>(groups.map(group => [group, []]));
    for (const record of records) rowsByGroup.get(folded(groupOf(record)))?.push(record);
    // An order that reads a number gives each slot where it sits; only when every slot has one is the axis numeric.
    const positions = groups.map(group => (order?.at && group !== other ? order.at(group) : null));
    const numeric = positions.length > 0 && positions.every(position => position !== null);
    const slots: ChartSlot[] = groups.map((group, index) => ({ key: group || 'all', label: nameOf(group) || label, ...(numeric ? { at: positions[index] as number } : {}) }));
    data = { slots, series: measures.length ? seriesOf(groups.map(group => rowsByGroup.get(group) ?? [])) : [{ id: 'value', label, slot: 0, values: groups.map(group => reduce(rowsByGroup.get(group) ?? [])) }] };
  }
  data.value_kind = placement.value_kind ?? (counting && !measures.length ? 'count' : 'number');
  if (placement.bins && !measures.length) data.value_kind = 'count';
  data.lines = linesOf(placement.lines ?? [], answer, data.bucket);
  if (typeof placement.curve === 'string') data.curve = placement.curve;
  if (typeof placement.fill === 'string') data.fill = placement.fill;
  const drawn = Array.isArray(placement.derive) && placement.derive.length ? withDerivations(data, placement.derive) : data;
  const baseline = placement.baseline === 'first' ? firstReading(drawn) : numberOf(placement.baseline);
  if (baseline !== null) drawn.baseline = baseline;
  const mid = midOf(drawn, placement.mid_path ? numberOf(readPath(answer, placement.mid_path)) : placement.mid);
  if (mid !== null) drawn.mid = mid;
  return drawn;
}

/** The first number the first series holds (a line's start), or null. */
function firstReading(data: ChartData): number | null {
  const found = (data.series[0]?.values ?? []).find((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return found === undefined ? null : found;
}

/** The change over a chart's first series: its first reading to its last, as a percent of the first; null with fewer than two readings or a first of zero. */
export function seriesChange(data: ChartData): number | null {
  const values = (data.series[0]?.values ?? []).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length < 2 || values[0] === 0) return null;
  return ((values[values.length - 1] - values[0]) / Math.abs(values[0])) * 100;
}

/** A change as it reads under a range ("+3.2%", "-1.4%", "0.0%") and the tone it takes (rise, fall; none when flat). */
export function changeWords(percent: number | null): { text: string; tone?: 'rise' | 'fall' } | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  const tenths = Math.round(percent * 10) / 10;
  if (tenths === 0) return { text: '0.0%' };
  return { text: `${tenths > 0 ? '+' : '-'}${Math.abs(tenths).toFixed(1)}%`, tone: tenths > 0 ? 'rise' : 'fall' };
}

/**
 * The change each range of the placement shows (those with `show_change`, or all when the placement has `range_change`),
 * each worked out from the records as that range alone would draw them, counted back from the latest record.
 */
export function rangeChanges(input: ChartInput): Record<string, ReturnType<typeof changeWords>> {
  const { placement } = input;
  const found: Record<string, ReturnType<typeof changeWords>> = {};
  for (const range of Array.isArray(placement.ranges) ? placement.ranges : []) {
    if (!range || !range.id || !(range.show_change ?? placement.range_change)) continue;
    const alone = { ...placement, derive: undefined, baseline: undefined };
    found[range.id] = changeWords(seriesChange(chartFromRecords({ ...input, placement: alone, range: range.id })));
  }
  return found;
}

/** The reference lines a placement's rows name, for the bucket the chart is drawn in. */
export function linesOf(rows: readonly ChartLineRow[], answer: unknown, bucket: string | undefined): ChartLine[] {
  const lines: ChartLine[] = [];
  rows.forEach((row, index) => {
    const found = row.from ? readPath(answer, row.from) : [row];
    for (const [at, one] of (Array.isArray(found) ? found : []).entries()) {
      if (row.from && !kept(one, row.where)) continue;
      const value = row.from ? numberOf(readPath(one, row.value_path ?? ['value'])) : numberOf(row.value);
      if (value === null) continue;
      const lineBucket = row.bucket_path ? words(readPath(one, row.bucket_path)) : row.bucket;
      if (lineBucket && bucket && lineBucket !== bucket) continue;
      const lineLabel = row.from && row.label_path ? words(readPath(one, row.label_path)) : row.label ?? '';
      lines.push({ id: `${row.id ?? `line-${index}`}:${at}`, label: lineLabel, value, tone: row.tone });
    }
  });
  return lines;
}

/** One series of points (oldest first) as ChartData: a number each, or { t, value } with its moment, which names its
 *  slot by its day. For the small lines under a number (a stat card, a trend tile, a metric). */
export function chartOfPoints(points: readonly (number | { t?: number; value: number })[], { label, value_kind, tone }: { label: string; value_kind?: string; tone?: string }): ChartData {
  const slots: ChartSlot[] = points.map((point, index) => {
    const t = typeof point === 'number' ? undefined : point.t;
    return { key: String(t ?? index), label: t !== undefined ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : String(index + 1), ...(t !== undefined ? { t } : {}) };
  });
  const values = points.map(point => numberOf(typeof point === 'number' ? point : point.value));
  return { slots, series: [{ id: 'value', label, slot: 0, values, ...(tone ? { tone } : {}) }], value_kind: value_kind ?? 'number' };
}

// ---------------------------------------------------------------------------------------------------------------------
// The chart a list starts with, from its own fields (the Chart view of any list, a placed chart with no chart named).
// ---------------------------------------------------------------------------------------------------------------------

export const isDateField = (field: FieldDescriptor) => field.kind === 'date' || field.ruleKind === 'date';
export const isNumberField = (field: FieldDescriptor) => !isDateField(field) && (field.kind === 'money' || field.ruleKind === 'number' || field.ruleKind === 'duration' || field.ruleKind === 'bytes');
export const groupsBy = (field: FieldDescriptor) => !isDateField(field) && !isNumberField(field) && Boolean(field.groupable || field.values || field.kind === 'tag' || field.ruleKind === 'choice');

/** The chart a list starts with, from its own fields. */
export function startingPlacement(fields: FieldDescriptor[], label: string): ChartPlacement {
  const date = fields.find(isDateField);
  const number = fields.find(isNumberField);
  const group = fields.find(groupsBy);
  return {
    id: `chart:${label}`,
    mark: date ? (group ? 'stacked-bar' : 'bar') : 'donut',
    ...(number ? { reading: number.id, formula: 'sum' } : { formula: 'count' }),
    ...(group ? { group: group.id } : {}),
    ...(date ? { over: { field: date.id, bucket: 'day' } } : {}),
    limit: 6,
    ...(number?.kind === 'money' ? { value_kind: 'money' } : {}),
  };
}
