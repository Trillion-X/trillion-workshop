// packages/group/read-data/board-metric.ts
//
// The METRIC primitive (pure leaf): a measurable target on a board item — a current value moving from a
// baseline `start` toward a `target` (e.g. "read 12 books" 5/12, "save 5000" 1200/5000, "cut debt to 0"
// 1200 from a 5000 start, "lose 10kg" 82 from 90 toward 80). This is the QUANTITATIVE complement of the
// boolean checklist ("what") — it answers "how far, numerically, toward the number".
//
// Direction is derived from the NUMBERS, never an enum (enum-dissolution): progress is
// `(current - start) / (target - start)`, so an ascending goal (target > start) and a descending goal
// (target < start) run through the exact same math. One blind engine yields fraction / percent /
// remaining / over-achievement / a done flag / a progress ranking from DATA alone (L069/L090). Physics
// only: finite-number arithmetic, no clock, no board/domain vocabulary. Fail-closed: any malformed raw
// (or a target equal to the start — no span to measure) normalizes to null, never throws.

/** A measurable target: current value between a baseline `start` (default 0) and a `target`. */
export interface Metric {
  readonly current: number;
  readonly target: number;
  /** Baseline the goal is measured FROM (default 0). Lets a goal descend (debt, weight). */
  readonly start?: number;
  readonly unit?: string;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The baseline a metric is measured from (0 when unset). */
export function startOf(m: Metric): number {
  return m.start ?? 0;
}

/**
 * Fail-closed normalizer. A valid metric needs a finite `current`, a finite `target`, and (if present) a
 * finite `start` — with `target !== start` so there is a real span to measure. `unit` is an optional
 * non-empty string; a `start` of 0 is dropped (it is the default). Anything else → null.
 */
export function metricFromRaw(raw: unknown): Metric | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isFiniteNum(o.current) || !isFiniteNum(o.target)) return null;
  const hasStart = o.start !== undefined;
  if (hasStart && !isFiniteNum(o.start)) return null;
  const start = hasStart ? (o.start as number) : 0;
  if (o.target === start) return null; // no span → no meaningful fraction
  const unit = typeof o.unit === 'string' && o.unit.trim() !== '' ? o.unit.trim() : undefined;
  const base: Metric = { current: o.current, target: o.target };
  const withStart = start !== 0 ? { ...base, start } : base;
  return unit === undefined ? withStart : { ...withStart, unit };
}

/** Raw completion fraction — (current - start) / (target - start). Can exceed 1 when the target is beaten. */
export function fraction(m: Metric): number {
  const s = startOf(m);
  return (m.current - s) / (m.target - s);
}

/**
 * Completion percent for a progress BAR (0..100). A bar must not read 100% until the goal is actually
 * complete — rounding 99.5% up to 100 would show a false "done", so an INCOMPLETE metric caps at 99; a
 * complete/beaten one shows 100. For aggregation/composition use `completion` (exact, unrounded) instead.
 */
export function progressPct(m: Metric): number {
  if (isComplete(m)) return 100;
  return Math.max(0, Math.min(99, Math.round(fraction(m) * 100)));
}

/**
 * Exact completion in 0..1 (clamped, NOT rounded) — the value for COMPOSITION (rollup aggregation, any
 * downstream math), as opposed to `progressPct` which rounds for a display bar. Over-achievement caps at 1.
 * A rollup fed the display-rounded percent would report a 99.5% child as a complete 1.0; this does not.
 */
export function completion(m: Metric): number {
  const f = fraction(m);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** The target has been reached (or beaten) — direction-independent via the fraction. */
export function isComplete(m: Metric): boolean {
  return fraction(m) >= 1;
}

/** How much is left to reach the target, in the metric's own units — never negative (0 once met). */
export function remaining(m: Metric): number {
  return isComplete(m) ? 0 : Math.abs(m.target - m.current);
}

/** How far past the target, in the metric's own units — 0 unless beaten. */
export function overBy(m: Metric): number {
  return fraction(m) <= 1 ? 0 : Math.abs(m.current - m.target);
}

/** Replace the current value (finite only; a bad value is ignored). */
export function setCurrent(m: Metric, value: number): Metric {
  if (!isFiniteNum(value)) return m;
  return { ...m, current: value };
}

/** Move the current value by a delta (finite only). */
export function addToCurrent(m: Metric, delta: number): Metric {
  if (!isFiniteNum(delta)) return m;
  return { ...m, current: m.current + delta };
}

/** Replace the target (finite + must keep a span, i.e. != start, else ignored). */
export function setTarget(m: Metric, target: number): Metric {
  if (!isFiniteNum(target) || target === startOf(m)) return m;
  return { ...m, target };
}

/** Human-readable value: "5/12 books" (unit optional). */
export function formatValue(m: Metric): string {
  const base = `${m.current}/${m.target}`;
  return m.unit ? `${base} ${m.unit}` : base;
}

/** A row for ranking items by completion. */
export interface MetricRow<T> {
  readonly item: T;
  readonly metric: Metric;
  readonly pct: number;
}

/**
 * Rank items that carry a metric by completion percent. `descending` (default) puts the most-complete
 * first ("almost there"); pass false for least-complete first ("needs the most work"). Items without a
 * metric are excluded. Pure — no clock, stable input order preserved for ties.
 */
export function rankByProgress<T>(items: readonly T[], metricOf: (item: T) => Metric | null, descending = true): MetricRow<T>[] {
  const rows: MetricRow<T>[] = [];
  items.forEach((item) => {
    const metric = metricOf(item);
    if (metric) rows.push({ item, metric, pct: progressPct(metric) });
  });
  return rows.sort((a, b) => (descending ? b.pct - a.pct : a.pct - b.pct));
}
