// package-set://bitfield-studio/packages/investment-command/read-data/cockpit-board.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The cockpit's visual-database DATA bindings. The cockpit renders the agent status
// fact through visual-database's generic primitive: WHICH metrics, WHICH watchlist
// columns + their status options/tones, and WHICH chart timeframes are all DATA
// — authored as records the UI reads, never literals in the panel. This module
// only names the input bindings and decodes the chart-range OptionSpec into the
// LineChart's range shape.
//
//   - `agent:cockpit-board.fields`  — hero field descriptors: the headline/delta
//     (role:'headline'/'delta') + the metric tiles (role:'metric'), each with
//     paths into the cycle payload + a domain `format`. Adding/renaming a metric
//     is a DATA edit here, zero code.
//   - `agent:cockpit-board.views`   — the watchlist kind:'table' view + its signal
//     field descriptors (symbol/momentum/status with domain options + tones +
//     pulse). The status dot + option tones come from this DATA.
//   - `agent:cockpit-board.ranges`  — the chart timeframe OptionSpec (1D/1W/.../All)
//     as `{ values:[{id,label,order}] }`. The LineChart range row is this DATA.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. NO domain vocabulary: this module names input bindings + decodes an option
//    list. It never enumerates metrics, columns, statuses, or timeframes.
// 2. The range decode is a pass-through of the `domain.values` shape every
//    visual-database choice field already uses — one option shape, reused.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/** Input name → the hero field descriptors DATA (`agent:cockpit-board.fields`). */
export const COCKPIT_FIELDS_INPUT = 'cockpit-fields';
/** Input name → the watchlist view + signal field descriptors (`agent:cockpit-board.views`). */
export const COCKPIT_VIEWS_INPUT = 'cockpit-views';
/** Input name → the chart timeframe OptionSpec (`agent:cockpit-board.ranges`). */
export const COCKPIT_RANGES_INPUT = 'cockpit-ranges';

/** The address labels the input descriptors bind to (single source for delivery). */
export const COCKPIT_FIELDS_ADDRESS = 'agent:cockpit-board.fields';
export const COCKPIT_VIEWS_ADDRESS = 'agent:cockpit-board.views';
export const COCKPIT_RANGES_ADDRESS = 'agent:cockpit-board.ranges';

/** One selectable timeframe in the LineChart range row — the same {id,label}
 *  shape LineChart consumes, sourced from an OptionSpec descriptor's values. */
export interface CockpitRange {
  id: string;
  label: string;
}

// The hero is ONE status record, not a human-authored row. `decodeVisualDatabaseModel`
// gates out non-human records (no authored title/body) — correct for a board of
// user records, wrong for a single metric source. So the hero record is built
// DIRECTLY here (the metric strip reads it via the SAME generic field descriptors
// through RecordMetricRow's `extractFieldValue`); only the descriptors are decoded
// from DATA. The watchlist rows DO have a title and go through the normal model.
import {
  decodeVisualDatabaseFields,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseLaneDescriptor,
  type VisualDatabaseRecord,
} from '../../keep-lists-of-rows/read-data/visual-database.ts';
import type { CockpitRecordRow } from './read-trading-agent-cycle.ts';

const HERO_LANE: VisualDatabaseLaneDescriptor = { id: 'hero', label: 'Hero', order: 0 };

/** Decode the hero field descriptors from the fields DATA (the strip's columns). */
export function decodeCockpitFields(raw: unknown): readonly VisualDatabaseFieldDescriptor[] {
  return decodeVisualDatabaseFields(raw);
}

/** The name of the projected row group this table binds to — declared in the
 *  views DATA as a top-level `source` (e.g. `"source": "signals"` /
 *  `"markets"`). Absent -> null (the panel then shows no table rows rather than
 *  guessing a key). One DATA field selects which of the fact's arrays renders; no
 *  array key is privileged in code. */
export function decodeViewSource(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const source = raw.source ?? raw.row_source ?? raw.rowSource;
  return typeof source === 'string' && source.length > 0 ? source : null;
}

/** Build the hero visual-database record directly from the projected row, bypassing
 *  the human-record gate. `raw` carries `{ payload }` so the descriptors' `paths`
 *  (`['payload', key]`) resolve exactly as on any record. */
export function buildHeroRecord(row: CockpitRecordRow | null): VisualDatabaseRecord | null {
  if (!row) return null;
  return {
    id: row.address,
    title: row.address,
    body: '',
    kind: 'cockpit-hero',
    group: 'cockpit-hero',
    lane: HERO_LANE,
    date: null,
    sort: null,
    badges: [],
    links: [],
    raw: { address: row.address, payload: row.payload },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Unwrap a `{ value_json }` fact wrapper, else return the value as-is. */
function unwrap(raw: unknown): unknown {
  if (isRecord(raw) && typeof raw.value_json === 'string') {
    try {
      return JSON.parse(raw.value_json);
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * Decode the chart-range OptionSpec into LineChart's range list. Accepts the
 * visual-database domain shape `{ values: [{ id, label, order }] }` (or a bare
 * array), ordered by `order`. Absent/unreadable → empty (LineChart hides the row).
 */
export function decodeRangeOptions(raw: unknown): CockpitRange[] {
  const value = unwrap(raw);
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.values)
      ? value.values
      : [];
  return list
    .filter(isRecord)
    .map((entry, index) => ({
      id: typeof entry.id === 'string' ? entry.id : String(entry.id ?? index),
      label: typeof entry.label === 'string' ? entry.label : String(entry.label ?? entry.id ?? index),
      order: typeof entry.order === 'number' ? entry.order : index,
    }))
    .sort((left, right) => left.order - right.order)
    .map(({ id, label }) => ({ id, label }));
}
