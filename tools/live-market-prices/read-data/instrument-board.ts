// package-set://bitfield-studio/packages/market-data-feed/read-data/instrument-board.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The GENERIC, self-describing data contract the market surface renders. This
// is the data-to-human translation boundary (L098 / Physics-vs-Society): the
// agent writes a cycle fact; THIS module turns it into a generic board the TSX
// renders WITHOUT knowing any domain word ("momentum", "buy", "stock",
// "option", "Yes/No"). The TSX is a dumb generic renderer — it iterates the
// columns/cells/metrics/series this module produces and never names a field.
//
// WHY GENERIC (enum-dissolution + L090 self-describing data): the WHAT a row
// plots is DATA. A stock row's salient columns are price + change%; an option-
// chain row's are strike/expiry/IV/delta; a Polymarket market's are outcome +
// price + change. None of those is special-cased in code — each is just a
// different set of `columns` and `cells`. Point the SAME renderer at any of
// them by changing only DATA.
//
// TWO SOURCES, ONE CONTRACT:
//   1. EXPLICIT — the cycle carries a `board`/`columns`/`rows` descriptor: the
//      owner (the AI / policy) declared the columns. We pass them through
//      verbatim. This is the forward path: a richer instrument writes a richer
//      descriptor; zero code change here.
//   2. PROJECTED — the cycle carries rows of self-describing scalar fields with
//      no explicit column descriptor: we DERIVE columns by taking the union of
//      the scalar fields present across the rows, label them from a `field_labels`
//      map when present (else humanize the field id), and read each row's value
//      per field. We hardcode NO field name — whatever scalars the rows carry
//      become the columns. A row with `momentum_pct` gets a column for free; a
//      row with `implied_vol` gets a column for free.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO domain vocabulary in field selection. We never test for a specific
//    field name. Columns come from the data's declared descriptor or from the
//    union of the rows' own scalar keys.
// 2. PURE: no React, no I/O. Decode + project only.
// 3. HONEST: absent data yields an empty board. We never fabricate columns,
//    rows, or a headline the data does not support.
// 4. TONE is data-or-derived, never hardcoded per domain. A cell may declare
//    its own tone; a numeric cell with no declared tone derives sign-tone
//    (positive=success, negative=error) only when the column is flagged
//    `signed` in the data — otherwise neutral.
//
// =============================================================================
// AUTHORING NOTE
// =============================================================================
//
// The extensive documentation in this file is a design feature. Do not remove
// it.
// =============================================================================

export type CellTone = 'neutral' | 'success' | 'error';

/** A column the board renders. Declared by data, or derived from row keys. */
export interface BoardColumn {
  /** Stable id matching the key in each row's value map. */
  id: string;
  /** Human header (e.g. "Momentum", "Strike", "Yes"). */
  label: string;
  /** Right-align numeric columns (fey numeral discipline). Default: end. */
  align?: 'start' | 'end';
  /** When true, a numeric value with no explicit tone derives sign tone. */
  signed?: boolean;
}

/** One cell = one column's value for one row. */
export interface BoardCell {
  columnId: string;
  /** Pre-formatted display text (the projector formats numbers to strings). */
  text: string;
  tone: CellTone;
}

/** A small marker chip on a row (e.g. the agent's action flag). Data-driven —
 *  the label + tone come from the data, never a hardcoded word. */
export interface BoardMarker {
  label: string;
  tone: CellTone;
}

/** One row of the instrument board (one evaluated instrument). */
export interface BoardRow {
  /** Stable row id (used as React key). */
  id: string;
  /** The row's primary identity label (e.g. ticker, contract, outcome). */
  label: string;
  /** Secondary line under the label when present (e.g. underlying, expiry). */
  sublabel: string | null;
  /** Cells keyed to the board columns, in column order. */
  cells: BoardCell[];
  /** Action/state marker chip when present. */
  marker: BoardMarker | null;
  /** Quiet state caption when present and no marker. */
  state: string | null;
}

/** A metric strip cell (fey hairline MetricRow). */
export interface BoardMetric {
  label: string;
  value: string;
  tone: CellTone;
}

/** A selectable timeframe for the series chart — data-driven. */
export interface BoardRange {
  id: string;
  label: string;
}

/** The series the chart plots, with a headline read-out when present. */
export interface BoardSeries {
  /** The plotted points, oldest then newest. */
  points: { value: number; t?: number }[];
  /** Headline label above the chart (e.g. instrument identity). */
  title: string | null;
  /** Headline value (e.g. last price), pre-formatted. null when unknown. */
  headlineValue: string | null;
  /** Signed delta string (e.g. "+1.24 (+0.9%)"), pre-formatted. */
  deltaText: string | null;
  /** Tone for the headline delta + the line. */
  tone: CellTone;
  /** Unit prefix the chart axis reuses (e.g. "$"); empty string when none. */
  valuePrefix: string;
}

/** The complete generic board the TSX renders. Everything here is data. */
export interface InstrumentBoard {
  /** Section title for the instrument list (data-driven, plain language). */
  title: string;
  /** The chart series + headline. */
  series: BoardSeries;
  /** Timeframe options for the chart (data-driven). */
  ranges: BoardRange[];
  /** The metric strip. */
  metrics: BoardMetric[];
  /** The column descriptor for the instrument table. */
  columns: BoardColumn[];
  /** The evaluated-instrument rows. */
  rows: BoardRow[];
  /** A human note (e.g. why the agent held). null when none. */
  note: string | null;
  /** True when ANY board content (rows or series) is present. */
  hasContent: boolean;
}

// ---------------------------------------------------------------------------
// Low-level readers (pure)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asTone(value: unknown): CellTone | null {
  if (value === 'success' || value === 'error' || value === 'neutral') return value;
  return null;
}

/** Humanize a machine field id into a header label ("momentum_pct" then
 *  "Momentum pct"; "impliedVol" then "Implied vol"). Used as a presentation
 *  fallback when the data declares no label — never a domain assumption. */
function humanizeId(id: string): string {
  const spaced = id
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.length === 0 ? id : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Format a scalar into display text. Numbers get a sensible default; the data
 *  may pre-format by sending a string. A `signed` numeric prepends "+". */
function formatScalar(value: unknown, opts: { signed?: boolean; suffix?: string; prefix?: string }): string {
  const num = asNumber(value);
  if (num !== null) {
    const sign = opts.signed && num >= 0 ? '+' : '';
    const body = Number.isInteger(num) ? String(num) : num.toFixed(2);
    return `${opts.prefix ?? ''}${sign}${body}${opts.suffix ?? ''}`;
  }
  return asString(value) ?? '—';
}

function deriveTone(value: unknown, column: { signed?: boolean }): CellTone {
  if (!column.signed) return 'neutral';
  const num = asNumber(value);
  if (num === null) return 'neutral';
  return num > 0 ? 'success' : num < 0 ? 'error' : 'neutral';
}

// ---------------------------------------------------------------------------
// EXPLICIT path — the cycle declared its own board descriptor
// ---------------------------------------------------------------------------

function decodeExplicitColumns(raw: unknown): BoardColumn[] {
  if (!Array.isArray(raw)) return [];
  const columns: BoardColumn[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    if (!id) continue;
    columns.push({
      id,
      label: asString(entry.label) ?? humanizeId(id),
      align: entry.align === 'start' ? 'start' : 'end',
      signed: entry.signed === true,
    });
  }
  return columns;
}

// ---------------------------------------------------------------------------
// PROJECTED path — derive columns from the union of each row's scalar fields
// ---------------------------------------------------------------------------

// Keys that name a row's IDENTITY (not a column value). A small set of GENERIC
// identity keys — structural ("what is this row called"), NOT domain values. A
// row uses whichever it carries; none is required.
const IDENTITY_KEYS = ['id', 'label', 'name', 'symbol', 'sym', 'title'] as const;
const SUBLABEL_KEYS = ['sublabel', 'subtitle', 'detail', 'underlying', 'description'] as const;
const MARKER_KEYS = ['marker', 'flag', 'action_marker'] as const;
const STATE_KEYS = ['state', 'status', 'state_label'] as const;
// Structural keys that are never a displayed column value.
const RESERVED_KEYS = new Set<string>([
  ...IDENTITY_KEYS,
  ...SUBLABEL_KEYS,
  ...MARKER_KEYS,
  ...STATE_KEYS,
  'cells',
  'columns',
  'tone',
  'tones',
  'field_labels',
  'signed_fields',
]);

function firstKey(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in record && record[key] !== null && record[key] !== undefined) return record[key];
  }
  return undefined;
}

/** Project rows' scalar fields into the generic column set. Returns the field
 *  ids (in stable first-seen order) that carry a scalar value. NO field name is
 *  privileged — every non-reserved scalar becomes a column. */
function projectedFieldIds(rows: Record<string, unknown>[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (RESERVED_KEYS.has(key) || seen.has(key)) continue;
      const value = row[key];
      // Only scalar fields become columns (objects/arrays are not table cells).
      if (asNumber(value) !== null || asString(value) !== null) {
        seen.add(key);
        ordered.push(key);
      }
    }
  }
  return ordered;
}

function decodeMarker(value: unknown): BoardMarker | null {
  if (isRecord(value)) {
    const label = asString(value.label);
    if (!label) return null;
    return { label, tone: asTone(value.tone) ?? 'neutral' };
  }
  const label = asString(value);
  return label ? { label, tone: 'success' } : null;
}

// ---------------------------------------------------------------------------
// Row decode (handles explicit cells OR projected scalar fields)
// ---------------------------------------------------------------------------

function decodeRow(
  raw: unknown,
  index: number,
  columns: BoardColumn[],
  signedFields: ReadonlySet<string>,
): BoardRow | null {
  if (!isRecord(raw)) return null;
  const identity = asString(firstKey(raw, IDENTITY_KEYS));
  const id = asString(raw.id) ?? identity ?? `row-${index}`;
  const label = identity ?? id;
  const sublabel = asString(firstKey(raw, SUBLABEL_KEYS));
  const marker = decodeMarker(firstKey(raw, MARKER_KEYS));
  const state = asString(firstKey(raw, STATE_KEYS));

  // Per-cell tone overrides the data may declare: { tones: { columnId: tone } }.
  const toneMap = isRecord(raw.tones) ? raw.tones : {};
  // Explicit cells form: { cells: [{ columnId, value/text, tone }] }.
  const explicitCells = Array.isArray(raw.cells) ? raw.cells : null;

  const cells: BoardCell[] = columns.map((column) => {
    const signed = column.signed || signedFields.has(column.id);
    if (explicitCells) {
      const match = explicitCells.find((c) => isRecord(c) && asString(c.columnId) === column.id);
      if (isRecord(match)) {
        const text = asString(match.text) ?? formatScalar(match.value, { signed });
        return { columnId: column.id, text, tone: asTone(match.tone) ?? deriveTone(match.value, { signed }) };
      }
      return { columnId: column.id, text: '—', tone: 'neutral' };
    }
    const value = raw[column.id];
    const declaredTone = asTone(toneMap[column.id]);
    return {
      columnId: column.id,
      text: formatScalar(value, { signed }),
      tone: declaredTone ?? deriveTone(value, { signed }),
    };
  });

  return { id, label, sublabel, cells, marker, state };
}

// ---------------------------------------------------------------------------
// Metrics + series + ranges (all data-driven)
// ---------------------------------------------------------------------------

function decodeMetrics(raw: unknown): BoardMetric[] {
  if (!Array.isArray(raw)) return [];
  const metrics: BoardMetric[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const label = asString(entry.label);
    if (!label) continue;
    const text = asString(entry.text)
      ?? formatScalar(entry.value, {
        signed: entry.signed === true,
        prefix: asString(entry.prefix) ?? '',
        suffix: asString(entry.suffix) ?? '',
      });
    metrics.push({
      label,
      value: text,
      tone: asTone(entry.tone) ?? deriveTone(entry.value, { signed: entry.signed === true }),
    });
  }
  return metrics;
}

function decodeRanges(raw: unknown): BoardRange[] {
  if (!Array.isArray(raw)) return [];
  const ranges: BoardRange[] = [];
  for (const entry of raw) {
    if (isRecord(entry)) {
      const id = asString(entry.id);
      if (id) ranges.push({ id, label: asString(entry.label) ?? id });
    } else {
      const id = asString(entry);
      if (id) ranges.push({ id, label: id });
    }
  }
  return ranges;
}

function decodeSeries(raw: unknown): BoardSeries {
  const empty: BoardSeries = { points: [], title: null, headlineValue: null, deltaText: null, tone: 'neutral', valuePrefix: '' };
  if (!isRecord(raw)) return empty;
  const pointsRaw = Array.isArray(raw.points) ? raw.points : [];
  const points = pointsRaw
    .map((p) => {
      if (isRecord(p)) {
        const value = asNumber(p.value ?? p.v ?? p.close ?? p.c ?? p.y);
        if (value === null) return null;
        const t = asNumber(p.t ?? p.timestamp ?? p.time);
        return t === null ? { value } : { value, t: t > 10_000_000_000 ? t : t * 1000 };
      }
      const value = asNumber(p);
      return value === null ? null : { value };
    })
    .filter((p): p is { value: number; t?: number } => p !== null);
  return {
    points,
    title: asString(raw.title),
    headlineValue: asString(raw.headline_value) ?? asString(raw.headlineValue),
    deltaText: asString(raw.delta_text) ?? asString(raw.deltaText),
    tone: asTone(raw.tone) ?? 'neutral',
    valuePrefix: asString(raw.value_prefix) ?? asString(raw.valuePrefix) ?? '',
  };
}

// ---------------------------------------------------------------------------
// Top-level: decode a generic board from a self-describing board payload
// ---------------------------------------------------------------------------

/**
 * Decode a self-describing instrument-board payload into the generic
 * `InstrumentBoard` the renderer consumes. Accepts EITHER an explicit board
 * descriptor (with `columns`) OR a bare `{ rows: [...] }` it projects.
 *
 * This function privileges NO domain field. Pass it a stock cycle, an option
 * chain, or a prediction-market snapshot — it renders by data alone.
 */
export function decodeInstrumentBoard(
  raw: unknown,
  fallback: { title: string },
): InstrumentBoard {
  const record = isRecord(raw) ? raw : {};
  const fieldLabels = isRecord(record.field_labels)
    ? Object.fromEntries(Object.entries(record.field_labels).map(([k, v]) => [k, asString(v) ?? humanizeId(k)]))
    : {};
  const signedFields = new Set<string>(
    Array.isArray(record.signed_fields)
      ? record.signed_fields.map((f) => asString(f)).filter((f): f is string => f !== null)
      : [],
  );

  const rowRecords = (Array.isArray(record.rows) ? record.rows : [])
    .filter(isRecord) as Record<string, unknown>[];

  // Columns: explicit if declared, else projected from the rows' scalar fields.
  let columns = decodeExplicitColumns(record.columns);
  if (columns.length === 0 && rowRecords.length > 0) {
    columns = projectedFieldIds(rowRecords).map((id) => ({
      id,
      label: fieldLabels[id] ?? humanizeId(id),
      align: 'end',
      signed: signedFields.has(id),
    }));
  }

  const rows = rowRecords
    .map((row, index) => decodeRow(row, index, columns, signedFields))
    .filter((row): row is BoardRow => row !== null);

  const series = decodeSeries(record.series);

  return {
    title: asString(record.title) ?? fallback.title,
    series,
    ranges: decodeRanges(record.ranges),
    metrics: decodeMetrics(record.metrics),
    columns,
    rows,
    note: asString(record.note),
    hasContent: rows.length > 0 || series.points.length > 0,
  };
}
