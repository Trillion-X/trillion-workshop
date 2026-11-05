// packages/group/show/report-controls.ts
//
// The pure control model behind the board REPORT panel — the product surface for the generic reducer family
// (board-report.ts, b179/b180). The panel lets a user pick a reduction (Count/Aggregate/Distribution/Matrix) ×
// dimension × measure and see the rows; this file turns those picks into a `ReportDescriptor` and knows which
// controls are RELEVANT per reduction (so the panel hides dead pickers, L118). Fully DATA-driven: the options
// come straight from the b179 catalogs (REDUCTIONS / BOARD_DIMENSIONS / BOARD_MEASURES), so a new reduction,
// dimension, or measure appears in the panel with ZERO panel code (L090). Pure, deterministic.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { ReportDescriptor } from '../read-data/board-report.ts';
import { REDUCTIONS, BOARD_DIMENSIONS, BOARD_MEASURES, measureDefById } from '../read-data/board-report.ts';

/** A pickable option (key + human label) surfaced as a control button. */
export interface ReportOption {
  readonly key: string;
  readonly label: string;
}

/** The three picker catalogs, mirrored from the b179 report DATA catalogs (SSOT — no re-listing). */
export const REDUCTION_OPTIONS: readonly ReportOption[] = REDUCTIONS.map((r) => ({ key: r.key, label: r.label }));
export const DIMENSION_OPTIONS: readonly ReportOption[] = BOARD_DIMENSIONS.map((d) => ({ key: d.key, label: d.label }));
export const MEASURE_OPTIONS: readonly ReportOption[] = BOARD_MEASURES.map((m) => ({ key: m.key, label: m.label }));

/** Which controls matter for a reduction — gates dead pickers out of the panel (L118). */
export interface ControlRelevance {
  readonly dimension: boolean;
  readonly measure: boolean;
  readonly colDimension: boolean;
}

/** Relevance as DATA keyed by reduction key (a new reduction adds a row, or takes the dimension-only default —
 *  never a code branch). Mirrors the `ReportDescriptor` field docs: census groups by dimension; pivot needs a
 *  dimension + a measure; histogram groups by the measure's bands (dimension ignored); crosstab crosses two
 *  dimensions. */
export const REDUCTION_CONTROLS: Readonly<Record<string, ControlRelevance>> = {
  census: { dimension: true, measure: false, colDimension: false },
  pivot: { dimension: true, measure: true, colDimension: false },
  histogram: { dimension: false, measure: true, colDimension: false },
  crosstab: { dimension: true, measure: false, colDimension: true },
};

/** The relevant controls for a reduction (unknown reduction → dimension-only, a safe default). */
export function reportControlRelevance(reduction: string): ControlRelevance {
  return REDUCTION_CONTROLS[reduction] ?? { dimension: true, measure: false, colDimension: false };
}

/** Build a `ReportDescriptor` from the current picks, including only the fields the reduction actually uses
 *  (so an irrelevant leftover measure/dimension never distorts the report). Pure. */
export function buildReportDescriptor(
  reduction: string,
  dimension?: string,
  measure?: string,
  colDimension?: string,
): ReportDescriptor {
  const rel = reportControlRelevance(reduction);
  return {
    reduction,
    ...(rel.dimension && dimension ? { dimension } : {}),
    ...(rel.measure && measure ? { measure } : {}),
    ...(rel.colDimension && colDimension ? { colDimension } : {}),
  };
}

/** The current picker positions — what `ReportPanel` holds as state (the resolved form of a descriptor). */
export interface ReportControls {
  readonly reduction: string;
  readonly dimension: string;
  readonly measure: string;
  readonly colDimension: string;
}

/** Reasonable starting picks (census grouped by kind) — used when a descriptor omits a field. */
export const DEFAULT_REPORT_CONTROLS: ReportControls = { reduction: 'census', dimension: 'kind', measure: 'progress', colDimension: 'tag' };

/** The INVERSE of `buildReportDescriptor` — restore the picker positions from a saved descriptor (so opening a
 *  saved report re-selects its pickers). Missing fields fall back to the defaults so every picker has a value. */
export function controlsFromDescriptor(desc: ReportDescriptor, base: ReportControls = DEFAULT_REPORT_CONTROLS): ReportControls {
  return {
    reduction: desc.reduction || base.reduction,
    dimension: desc.dimension ?? base.dimension,
    measure: desc.measure ?? base.measure,
    colDimension: desc.colDimension ?? base.colDimension,
  };
}

/** Format a report row's value for display. Only `pivot` reports an aggregate in the MEASURE's units (percent /
 *  date / words); every other reduction's value is a plain count. `null` (no measurable value) → an em-dash. */
export function formatReportValue(desc: ReportDescriptor, value: number | null): string {
  if (value === null) return '—';
  if (desc.reduction === 'pivot' && desc.measure) {
    const m = measureDefById(desc.measure);
    if (m) return m.format(value);
  }
  return String(Math.round(value));
}
