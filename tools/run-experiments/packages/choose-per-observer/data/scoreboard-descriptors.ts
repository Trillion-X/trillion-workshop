// packages/choose-per-observer/data/scoreboard-descriptors.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The DATA that configures the experiment scoreboard surface. Everything that
// makes the scoreboard "an experiment scoreboard" rather than "a generic record
// board" lives HERE as data, never in the .tsx:
//
//   - Which metric columns appear (and their order, label, value path, and how
//     each raw value is formatted) — `SCOREBOARD_METRIC_DESCRIPTORS`.
//   - The status field whose option tones drive the per-row + hero status dot
//     (leading / winner / no-significance) — `SCOREBOARD_STATUS_DESCRIPTOR`.
//   - Plain, human-facing copy (the translation boundary: no internal vocabulary
//     reaches the screen) — `SCOREBOARD_COPY`.
//
// THE GENERIC TEST (must stay YES):
//   A new metric (e.g. "watch time", "signups", "refund rate") appears by adding
//   ONE descriptor row here. A new outcome status (e.g. "paused", "rolling out")
//   appears by adding ONE option to the status descriptor's domain. ZERO change
//   to ScoreboardSurface.tsx. There is no column array, no status union, and no
//   `if metric === ...` anywhere in the .tsx — the surface reads these rows.
//
// These are plain JS objects shaped as visual-database field descriptors so they
// decode straight through `decodeVisualDatabaseModel`. They are illustrative DATA
// (a first example); any owner authors their own rows live.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { VisualDatabaseFieldDescriptor } from '@/packages/visual-database/read-data/visual-database';

// ---------------------------------------------------------------------------
// Metric format kind (DATA, not a code switch)
//
// Each metric descriptor declares HOW its value reads to a human via a `format`
// hint carried in the descriptor's domain detail. The formatter (metric-format.ts)
// dispatches on this hint through a registry — a new format kind is a registry
// entry, never a new branch in a surface. The first kinds:
//   - "integer"  : whole counts (views, clicks)
//   - "currency" : money (revenue), owner-supplied currency symbol in copy
//   - "percent"  : a 0..1 ratio shown as N% (conversion rate, traffic weight)
//   - "text"     : passthrough string
// ---------------------------------------------------------------------------

/** The display-format hint a metric descriptor carries. Open string — the
 *  formatter registry resolves it; an unknown hint falls back to text. */
export type MetricFormatHint = string;

/** Read a metric descriptor's declared format hint from its domain detail.
 *  The hint lives in DATA so the surface never maps a field id to a format. */
export function metricFormatHint(descriptor: VisualDatabaseFieldDescriptor): MetricFormatHint {
  const detail = descriptor.domain?.details?.find((d) => d.id === 'format');
  // The detail descriptor carries the hint as its label (a plain DATA string).
  return detail?.label ?? 'text';
}

// ---------------------------------------------------------------------------
// Scoreboard metric columns (DATA)
//
// Rows of the board are candidates ("page versions"); columns are these metric
// descriptors. `paths` reads each value off the candidate row record the
// view-model builds. `role: 'metric'` marks it as a metric cell (excluded from
// the structural roles the table treats specially). Order is display order.
// ---------------------------------------------------------------------------

function metric(
  id: string,
  label: string,
  valueKey: string,
  format: MetricFormatHint,
): VisualDatabaseFieldDescriptor {
  return {
    id,
    label,
    role: 'metric',
    paths: [['payload', 'metrics', valueKey], ['metrics', valueKey]],
    domain: { details: [{ id: 'format', label: format, paths: [] }] },
    editable: false,
    sortable: true,
  };
}

/** The metric columns for the first-use scoreboard. Add a column → add a
 *  row here; the surface renders it with zero change. */
export const SCOREBOARD_METRIC_DESCRIPTORS: readonly VisualDatabaseFieldDescriptor[] = [
  metric('weight', 'Traffic', 'weight', 'percent'),
  metric('views', 'Visitors', 'views', 'integer'),
  metric('clicks', 'Clicks', 'clicks', 'integer'),
  metric('conversions', 'Purchases', 'conversions', 'integer'),
  metric('revenue', 'Revenue', 'revenue', 'currency'),
  metric('rate', 'Conversion rate', 'rate', 'percent'),
];

// ---------------------------------------------------------------------------
// Status descriptor (DATA-driven statusView — L090)
//
// The per-candidate + hero status (which version is ahead, which won, whether
// there is a confident result yet) is a DATA option on this field. The decoder
// (scoreboard-view-model.ts) emits a raw status key per row; this descriptor's
// domain maps key -> { label, tone, pulse }. A new status = a new option row,
// never a new `if status === ...` in the surface.
//
// Tones map to ui StatusDot / Badge tones: success | info | warning | neutral.
// ---------------------------------------------------------------------------

export const SCOREBOARD_STATUS_FIELD_ID = 'result';

export const SCOREBOARD_STATUS_DESCRIPTOR: VisualDatabaseFieldDescriptor = {
  id: SCOREBOARD_STATUS_FIELD_ID,
  label: 'Result',
  role: 'status',
  paths: [['payload', 'result'], ['result']],
  editable: false,
  domain: {
    values: [
      { id: 'leading', label: 'In the lead', tone: 'info', pulse: true, order: 1 },
      { id: 'winner', label: 'Winner', tone: 'success', pulse: false, order: 2 },
      { id: 'trailing', label: 'Trailing', tone: 'neutral', pulse: false, order: 3 },
      { id: 'collecting', label: 'Collecting data', tone: 'warning', pulse: true, order: 4 },
    ],
    // Open: an owner can mint a new result state (e.g. "paused") and it renders
    // as a quiet neutral option with zero code change.
    open: true,
  },
};

// ---------------------------------------------------------------------------
// Human copy (translation boundary — §6 of the contract)
//
// No internal vocabulary ("candidate", "decider", "observer", "fact") ever
// reaches the screen. Each string here is the human-facing word for a concept.
// ---------------------------------------------------------------------------

export const SCOREBOARD_COPY = {
  /** Title shown for the version (candidate) column. */
  versionColumnLabel: 'Version',
  /** The hero stat label when a leader exists. */
  leaderLabel: 'Most likely to win',
  /** The hero stat label for the leading version's win probability. */
  winProbabilityLabel: 'Win probability',
  /** Sublabel when there is not yet enough data to call a winner. */
  noSignificance: 'Not enough data yet',
  /** Owner action: promote the leading version to everyone. */
  chooseWinner: 'Choose winner',
  /** Empty state (N=0). */
  emptyTitle: 'No versions yet',
  emptyMessage: 'Add a version to start showing visitors different pages.',
  /** Sparse state (N=1) — a plain page, no experiment chrome. */
  sparseNote: 'One version live — everyone sees the same page.',
  /** Loading + error. */
  errorMessage: "Couldn't load results.",
  /** Currency symbol the currency formatter prepends (owner DATA). */
  currencySymbol: '$',
  /** Board heading. */
  heading: 'Versions',
} as const;

export type ScoreboardCopy = typeof SCOREBOARD_COPY;
