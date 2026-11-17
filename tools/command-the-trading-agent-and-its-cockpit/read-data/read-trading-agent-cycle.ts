// package-set://bitfield-studio/packages/investment-command/read-data/read-trading-agent-cycle.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The cockpit reads ONE record — the autonomous agent's own live status fact
// (`attribute_fact|agent:trading-momentum|last_cycle|type:json`, via the hash
// bridge) — through the visual-database generic primitive. This module is the
// self-describing translation boundary: it PROJECTS that raw fact into
// visual-database record ROWS (a hero record + one row per evaluated signal). It
// does NOT define a bespoke view schema — WHICH metrics/columns render is DATA
// (visual-database field descriptors authored at `agent:cockpit-board.*`), decoded
// by `decodeVisualDatabaseModel`, exactly like the Order surface.
//
// There is no cockpit view-model type here, no metric/signal enum, no momentum/
// equity vocabulary baked into a struct. The fact is an OPEN object whose keys
// vary by agent/venue; we copy its scalars onto a record payload verbatim and let
// the DATA descriptors decide what is shown and how. Point a different agent at
// this (Schwab options, a Polymarket market, an x402 wallet) by authoring
// different descriptor DATA — zero change here and zero change in the panel.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. SINGLE SOURCE: the agent owns the canonical `last_cycle` fact. This module
//    only READS + reshapes it into record rows. It never invents numbers, never
//    fabricates a cycle, never shows demo/sample data. Absent fact -> no rows.
// 2. SELF-DESCRIBING PASS-THROUGH: scalar fact keys are copied onto the record
//    payload verbatim; the visual-database field descriptors (DATA) select + format
//    them. Adding a metric/column is a DATA change, never a code change here.
// 3. TRANSLATION BOUNDARY: the one human-language translation kept here is the
//    canonical `holdReasonSentence` (re-exported from permission-lease), because
//    a reason CODE is internal vocabulary the product must never show raw.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { holdReasonSentence } from '../../permission-lease/read-data/hold-reason';

// Re-export the canonical hold-reason translator so the panel imports one place.
export { holdReasonSentence };

/**
 * The canonical HASH-MODE bridge label all trading surfaces read (the executor
 * publishes the cycle snapshot here so the browser read path can resolve it). The
 * input descriptor uses this as `value_address_label`. ONE shared address for all
 * trading surfaces (L043).
 */
export const TRADING_AGENT_CYCLE_BRIDGE_LABEL = 'agent:trading-momentum.last-cycle';

/**
 * The underlying raw identity-text fact label (subject `agent:trading-momentum`).
 * Non-browser readers can read this directly at address_mode identity_text; browser
 * surfaces use the hash bridge above because the in-browser read path hashes labels.
 */
export const TRADING_AGENT_CYCLE_FACT_LABEL =
  'attribute_fact|agent:trading-momentum|last_cycle|type:json';

/** Input name the panel reads via useBitfieldData('trading-agent-cycle'). */
export const TRADING_AGENT_CYCLE_INPUT = 'trading-agent-cycle';

// ---------------------------------------------------------------------------
// RAW PAYLOAD READERS — the fact is an OPEN object; coerce defensively, never
// assume a fixed schema.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * The fact payload is `{ property_id, subject_id, table, type_id, value_json }`
 * where value_json is a JSON string. The input may also already be the parsed
 * summary (depending on the read pipeline), so we unwrap both shapes.
 */
function unwrapSummary(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.value_json === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw.value_json);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if ('equity' in raw || 'cycle_id' in raw || 'daily_pl_pct' in raw || 'decisions' in raw) return raw;
  return null;
}

// ---------------------------------------------------------------------------
// PROJECTION — raw fact -> visual-database record ROWS (no view-model type).
// ---------------------------------------------------------------------------

/** A visual-database record row: `{ address, payload }`. The board's decoder reads
 *  the payload via each descriptor's `paths` — so we keep the fact's own keys. */
export interface CockpitRecordRow {
  address: string;
  payload: Record<string, unknown>;
}

/** What the panel needs from the live fact: the hero record (the cycle scalars),
 *  the per-array row groups for visual-database table views, the price series for the
 *  trend line, and the plain hold-reason line. All DATA-shaped or primitive — NO
 *  cockpit-specific view types, and NO privileged array-key names. */
export interface CockpitProjection {
  /** True only when a real fact was decoded. */
  reported: boolean;
  /** The one record whose scalar fields feed the hero metric strip + headline. */
  heroRecord: CockpitRecordRow | null;
  /**
   * Every array-of-objects key in the fact, projected into visual-database rows and
   * keyed by the fact's OWN key name (e.g. `signals`, `decisions`, `markets`,
   * `positions`). A table view binds to a group by name via its DATA (`source`),
   * so a different agent/venue surfaces its own arrays with ZERO code change. The
   * projection never privileges a specific key — it is a pass-through of structure.
   */
  rowGroups: Readonly<Record<string, readonly CockpitRecordRow[]>>;
  /** Closing-price series the agent reported, if any (for the headline trend). */
  priceSeries: readonly number[];
  /** The plain-language hold-reason line (canonical translation), or null. */
  holdLine: string | null;
}

const EMPTY_PROJECTION: CockpitProjection = {
  reported: false,
  heroRecord: null,
  rowGroups: {},
  priceSeries: [],
  holdLine: null,
};

/** Copy every scalar key of an object onto a flat payload (arrays/objects are
 *  dropped — they are not metric/column values; the table reads nested rows
 *  separately). Verbatim keys mean the DATA descriptors' `paths` resolve. */
function scalarPayload(source: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      payload[key] = value;
    }
  }
  return payload;
}

/** A row's stable address: the first present human-ish identifier on the entry,
 *  else a group-scoped index. No privileged key — any identifier-shaped string
 *  field works, falling back to a deterministic synthetic address. */
function rowAddress(entry: Record<string, unknown>, group: string, index: number): string {
  for (const value of Object.values(entry)) {
    const text = str(value);
    if (text) return text;
  }
  return `agent:cockpit:${group}:${index}`;
}

/** Project the agent status fact into visual-database rows. The hero record is the
 *  cycle's scalar fields; EVERY array-of-objects key becomes a named row group
 *  (each entry copied verbatim) so the board renders any agent's arrays via DATA
 *  columns. The key names are the fact's own — nothing is privileged here. */
export function projectCockpit(raw: unknown): CockpitProjection {
  const summary = unwrapSummary(raw);
  if (!summary) return EMPTY_PROJECTION;

  const heroRecord: CockpitRecordRow = {
    address: str(summary.cycle_id) ?? 'agent:cockpit:hero',
    payload: scalarPayload(summary),
  };

  // Pass-through of structure: each array-of-objects key -> rows keyed by name.
  const rowGroups: Record<string, readonly CockpitRecordRow[]> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (!Array.isArray(value)) continue;
    const objects = value.filter(isRecord);
    if (objects.length === 0) continue;
    rowGroups[key] = objects.map((entry, index) => ({
      address: rowAddress(entry, key, index),
      payload: scalarPayload(entry),
    }));
  }

  const priceSeries = Array.isArray(summary.price_series)
    ? summary.price_series.map(num).filter((value): value is number => value !== null)
    : [];

  const holdLine = holdReasonSentence(str(summary.hold_reason), num(summary.momentum_threshold_pct));

  return { reported: true, heroRecord, rowGroups, priceSeries, holdLine };
}
