// tools/traffic-attribution/read-data/traffic-signals-rollup.ts
//
// Maintained rollup for traffic attribution. Per-observer facts live at
// label-hash addresses (observer::<id>::...) which cannot be range-enumerated, so
// the live attribution board reads ONE compact per-project aggregate that each
// visit upserts idempotently per observer (Codex perf delta #7: maintained
// rollup, never a per-render full-log scan).
//
// The aggregate holds one row per observer: first-touch signals (source/utm/...)
// + whether the observer converted. `buildTrafficSignalUpsert` folds a visit into
// the aggregate (first-touch signals preserved, conversion OR'd). `rowsToFacts`
// converts the rows to the AddressedFact form projectTrafficAttribution consumes,
// so there is ONE projection path for live + offline.
//
// Generic: signal keys + conversion are DATA; no source/medium/campaign literal.
// Pure: no React, no I/O, no clock (caller supplies `at`).

import type { AddressedFact } from './aggregate-by-dimension.ts';

/** One observer's first-touch signals + conversion state. */
export interface TrafficSignalRow {
  observer_id: string;
  /** first-touch signal values keyed by signal name (source/utm_source/...). */
  signals: Record<string, string>;
  /**
   * true once the observer has a metric-less / DEFAULT conversion (a conversion with no
   * explicit outcome metric). It counts toward the caller's default `conversionMetric` in
   * rowsToFacts (L116). Explicit outcomes go in `outcomes` instead.
   */
  converted?: boolean;
  /**
   * Explicit outcome metric keys this observer fired (DATA, e.g. ["lead","purchase"]).
   * Each stamps its own outcome fact, so a board can show a column per outcome and a
   * `signup`/`lead` never counts as a `purchase`. Generic: the traffic primitive owns
   * multi-outcome; no outcome name lives in code.
   */
  outcomes?: string[];
  /**
   * Accumulated conversion VALUE for this observer (DATA — e.g. the sale amount, summed
   * across all of this observer's conversions). rowsToFacts stamps it at
   * observer::<id>::candidate::value, where a `sumOverEntities` metric sums it across a
   * dimension group → revenue-per-source (ROAS). Only positive numbers are kept; absent =
   * no monetary value (a metric-less / no-amount conversion). The traffic primitive owns
   * value; no currency or amount lives in code.
   */
  value?: number;
  /** ISO 8601 first-seen timestamp (caller-supplied; rollup never reads a clock). */
  first_seen?: string;
}

export interface TrafficSignalsAggregate {
  kind: 'traffic-signals';
  rows: TrafficSignalRow[];
}

/** A single visit's contribution to the rollup. */
export interface TrafficSignalVisit {
  observerId: string;
  /** signal values seen this visit (empty/absent values ignored). */
  signals: Record<string, string | null | undefined>;
  converted?: boolean;
  /** this visit's conversion value (amount); summed into the observer's row value. */
  value?: number;
  at?: string;
}

const EMPTY: TrafficSignalsAggregate = { kind: 'traffic-signals', rows: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Narrow an unknown payload to a TrafficSignalsAggregate (tolerant). */
export function readTrafficSignalsAggregate(value: unknown): TrafficSignalsAggregate {
  if (!isRecord(value) || !Array.isArray(value.rows)) return { kind: 'traffic-signals', rows: [] };
  const rows: TrafficSignalRow[] = [];
  for (const raw of value.rows) {
    if (!isRecord(raw) || typeof raw.observer_id !== 'string' || raw.observer_id.length === 0) continue;
    const signals: Record<string, string> = {};
    if (isRecord(raw.signals)) {
      for (const [k, v] of Object.entries(raw.signals)) {
        if (typeof v === 'string' && v.trim().length > 0) signals[k] = v.trim();
      }
    }
    const outcomes = Array.isArray(raw.outcomes)
      ? raw.outcomes.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim())
      : undefined;
    const value = typeof raw.value === 'number' && Number.isFinite(raw.value) && raw.value > 0 ? raw.value : undefined;
    rows.push({
      observer_id: raw.observer_id,
      signals,
      converted: raw.converted === true,
      ...(outcomes && outcomes.length > 0 ? { outcomes } : {}),
      ...(value !== undefined ? { value } : {}),
      first_seen: typeof raw.first_seen === 'string' ? raw.first_seen : undefined,
    });
  }
  return { kind: 'traffic-signals', rows };
}

/**
 * Fold a visit into the aggregate, returning a NEW aggregate (pure).
 *
 * First-touch: an existing row's non-empty signal value is NEVER overwritten;
 * only missing signals are filled. Conversion is monotonic (false -> true, never
 * back). A new observer appends a row. Idempotent: re-folding the same visit is a
 * no-op once signals are set and conversion latched.
 */
export function buildTrafficSignalUpsert(
  aggregate: TrafficSignalsAggregate | unknown,
  visit: TrafficSignalVisit,
): TrafficSignalsAggregate {
  const current = ((): TrafficSignalsAggregate => {
    if (isRecord(aggregate) && (aggregate as TrafficSignalsAggregate).kind === 'traffic-signals' && Array.isArray((aggregate as TrafficSignalsAggregate).rows)) {
      return readTrafficSignalsAggregate(aggregate);
    }
    return EMPTY;
  })();

  const cleanSignals: Record<string, string> = {};
  for (const [k, v] of Object.entries(visit.signals ?? {})) {
    if (typeof v === 'string' && v.trim().length > 0) cleanSignals[k] = v.trim();
  }

  const rows = current.rows.map((r) => ({ ...r, signals: { ...r.signals } }));
  const existing = rows.find((r) => r.observer_id === visit.observerId);

  const visitValue = typeof visit.value === 'number' && Number.isFinite(visit.value) && visit.value > 0 ? visit.value : 0;

  if (!existing) {
    rows.push({
      observer_id: visit.observerId,
      signals: cleanSignals,
      converted: visit.converted === true,
      ...(visitValue > 0 ? { value: visitValue } : {}),
      first_seen: visit.at,
    });
  } else {
    for (const [k, v] of Object.entries(cleanSignals)) {
      if (!existing.signals[k]) existing.signals[k] = v; // first-touch: fill only
    }
    existing.converted = existing.converted === true || visit.converted === true;
    if (visitValue > 0) existing.value = (existing.value ?? 0) + visitValue; // value ACCUMULATES (sum)
    if (!existing.first_seen && visit.at) existing.first_seen = visit.at;
  }

  return { kind: 'traffic-signals', rows };
}

/**
 * Convert rollup rows to the AddressedFact form projectTrafficAttribution reads:
 * each signal -> observer::<id>::observer::signal::<key>, plus an outcome fact at
 * observer::<id>::candidate::outcome::<metric> for EACH explicit outcome the observer
 * fired (row.outcomes), AND one at the caller's default `conversionMetric` when the
 * observer has a metric-less default conversion (row.converted) — preserving the L116
 * invariant that a metric-less conversion still counts as the default outcome. A board
 * can therefore show a column per outcome, and a `signup` never counts as a `purchase`.
 * One projection path (live rollup + offline facts both flow through this).
 */
export function rowsToFacts(
  aggregate: TrafficSignalsAggregate,
  conversionMetric = 'purchase',
): AddressedFact[] {
  const facts: AddressedFact[] = [];
  for (const row of aggregate.rows) {
    for (const [key, value] of Object.entries(row.signals)) {
      facts.push({ address: ['observer', row.observer_id, 'observer', 'signal', key], value });
    }
    for (const metric of row.outcomes ?? []) {
      facts.push({ address: ['observer', row.observer_id, 'candidate', 'outcome', metric], value: 1 });
    }
    if (row.converted) {
      facts.push({ address: ['observer', row.observer_id, 'candidate', 'outcome', conversionMetric], value: 1 });
    }
    if (typeof row.value === 'number' && row.value > 0) {
      // one value fact per observer (the accumulated total). A `sumOverEntities` metric over
      // ['candidate','value'] sums these across a dimension group → revenue-per-source (ROAS).
      facts.push({ address: ['observer', row.observer_id, 'candidate', 'value'], value: row.value });
    }
  }
  return facts;
}
