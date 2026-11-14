// packages/group/read-data/board-report.ts
//
// BOARD REPORT — the DATA descriptor that turns the whole reducer family into ONE composable primitive. The
// family has four reductions (census/pivot/histogram/crosstab) over three dimension KINDS (facet / bucketed
// measure / graph cluster). A "report" is just a CHOICE among them expressed as DATA: `{reduction, dimension,
// measure, aggregator}`. `runReport(items, descriptor)` is a BLIND runner — it looks the reduction, dimension,
// and measure up in DATA registries and dispatches; it names no specific report. So a saved board report is a
// record, and ANY (reduction × dimension × measure × aggregator) combination is a valid report with ZERO new
// code (L069/L090/enum-dissolution).
//
// This is ALSO the single source for the board's canonical measures + dimensions — `do-work/board-document-
// exports` imports them here rather than redefining, so there is ONE definition of "a card's progress / word
// count / deadline" and "the tag / colour / cluster dimension".

import type { BoardItem } from './group-board-model';
import { facetCensus, facetCensusText, type FacetExtract } from './board-facet-census';
import { facetPivot, facetPivotText, AGGREGATORS, aggregatorById, type BoardMeasure, type Aggregator } from './board-facet-pivot';
import { bucketDistribution, bucketDistributionText, bucketFacet, evenBuckets, type BucketSpec } from './board-measure-bucket';
import { crossTab, crossTabText } from './board-crosstab';
import { clusterFacet } from './board-cluster-facet';
import { cardCompletion } from 'trillion-workshop/tools/organize-the-sidebar/read-data/card-completion.ts';
import { dueDateFromRaw, dueMsToDateLabel } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-due-date.ts';
import { itemTags } from 'trillion-workshop/tools/organize-the-sidebar/show/item-tags.ts';
import { colorFacetOf, kindFamilyOf } from '../show/board-item-facets';

// ─── Canonical measures + buckets (one source) ──────────────────────────────────────────────────────────
/** A card's 0..1 completion as a measure (undefined → null: unmeasured, not a fake 0). */
export const PROGRESS_MEASURE: BoardMeasure = (item) => cardCompletion(item) ?? null;
/** A card's due date (ms epoch) as a measure, or null when it has none. */
export const DEADLINE_MEASURE: BoardMeasure = (item) => dueDateFromRaw((item.extra as Record<string, unknown> | undefined)?.dueDate);
/** A card's word count as a measure (always finite; empty text → 0). */
export const WORDS_MEASURE: BoardMeasure = (item) => (typeof item.text === 'string' ? item.text.split(/\s+/).filter(Boolean).length : 0);
/** Render a 0..1 fraction as a whole-percent string. */
export const formatPercent = (n: number): string => `${Math.round(n * 100)}%`;
/** Completion quartiles (0–25% … 75–100%). */
export const PROGRESS_BUCKETS: BucketSpec = evenBuckets(0, 1, 4, (lo, hi) => `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`);
/** Uneven word-count bands for a card-size histogram. */
export const SIZE_BUCKETS: BucketSpec = { edges: [10, 40, 100], labels: ['≤10 words', '10–40', '40–100', '100+ words'] };

// ─── Measure catalog (DATA) ─────────────────────────────────────────────────────────────────────────────
/** One measurable quantity on a card, its display units, and (when it makes sense) its histogram bands. */
export interface MeasureDef {
  readonly key: string;
  readonly label: string;
  readonly measure: BoardMeasure;
  /** Render the aggregate value in this measure's units (percent, date, plain number). */
  readonly format: (n: number) => string;
  /** Default histogram bands for this measure (absent → not a histogram axis). */
  readonly buckets?: BucketSpec;
}

export const BOARD_MEASURES: readonly MeasureDef[] = [
  { key: 'progress', label: 'Progress', measure: PROGRESS_MEASURE, format: formatPercent, buckets: PROGRESS_BUCKETS },
  { key: 'words', label: 'Word count', measure: WORDS_MEASURE, format: (n) => String(Math.round(n)), buckets: SIZE_BUCKETS },
  { key: 'deadline', label: 'Deadline', measure: DEADLINE_MEASURE, format: dueMsToDateLabel },
];
export function measureDefById(key: string): MeasureDef | null {
  return BOARD_MEASURES.find((m) => m.key === key) ?? null;
}

// ─── Dimension catalog (DATA) ───────────────────────────────────────────────────────────────────────────
/** One grouping dimension. `extract` takes the board so topology/measure dimensions (cluster, progress-band)
 *  can precompute; facet dimensions (tag/colour/kind) ignore it. */
export interface DimensionDef {
  readonly key: string;
  readonly label: string;
  readonly extract: (items: readonly BoardItem[]) => FacetExtract;
}

export const BOARD_DIMENSIONS: readonly DimensionDef[] = [
  { key: 'tag', label: 'Tag', extract: () => itemTags },
  { key: 'color', label: 'Colour', extract: () => colorFacetOf },
  { key: 'kind', label: 'Kind', extract: () => kindFamilyOf },
  { key: 'cluster', label: 'Cluster', extract: (items) => clusterFacet(items) },
  { key: 'progress-band', label: 'Progress band', extract: () => bucketFacet(PROGRESS_MEASURE, PROGRESS_BUCKETS) },
];
export function dimensionDefById(key: string): DimensionDef | null {
  return BOARD_DIMENSIONS.find((d) => d.key === key) ?? null;
}

// ─── Report descriptor + blind runner ───────────────────────────────────────────────────────────────────
/** A board report as DATA: which reduction, over which dimension(s), of which measure, aggregated how. */
export interface ReportDescriptor {
  /** A `REDUCTIONS` key: `census` | `pivot` | `histogram` | `crosstab`. */
  readonly reduction: string;
  /** A `BOARD_DIMENSIONS` key — the (row) grouping. Ignored by `histogram` (which groups by the measure). */
  readonly dimension?: string;
  /** A second `BOARD_DIMENSIONS` key — the column axis (crosstab only). */
  readonly colDimension?: string;
  /** A `BOARD_MEASURES` key — required by pivot/histogram, elective for crosstab (count when absent). */
  readonly measure?: string;
  /** An `AGGREGATORS` id — how pivot/crosstab reduce the measure (default `mean`). */
  readonly aggregator?: string;
  /** A heading override (else a generated one). */
  readonly title?: string;
}

/** One row of a report's STRUCTURED result — a group label, its number (count or aggregate, null when
 *  unmeasured), and the cards in it. The common shape across all four reductions, so a threshold predicate
 *  and a board selection work uniformly (the analysis → action bridge). `runReport` renders these to text;
 *  `reportRows` returns them raw; `reportSelect` unions the cardIds of the rows a predicate keeps. */
export interface ReportRow {
  readonly label: string;
  readonly value: number | null;
  readonly cardIds: readonly string[];
}

/** One reduction shape and how to run a descriptor through it. A DATA row — adding a reduction is a row.
 *  `run` renders markdown (for reading); `rows` returns the structured groups (for acting). */
export interface ReductionDef {
  readonly key: string;
  readonly label: string;
  readonly run: (items: readonly BoardItem[], desc: ReportDescriptor) => string;
  readonly rows: (items: readonly BoardItem[], desc: ReportDescriptor) => ReportRow[];
}

const aggOf = (desc: ReportDescriptor): Aggregator => aggregatorById(desc.aggregator ?? 'mean') ?? AGGREGATORS[1];
const heading = (desc: ReportDescriptor, fallback: string): string => desc.title ?? fallback;

export const REDUCTIONS: readonly ReductionDef[] = [
  {
    key: 'census',
    label: 'Count',
    run: (items, desc) => {
      const dim = dimensionDefById(desc.dimension ?? '');
      if (!dim) return `_unknown dimension_`;
      return facetCensusText(items, dim.extract(items), heading(desc, `${dim.label} counts`));
    },
    rows: (items, desc) => {
      const dim = dimensionDefById(desc.dimension ?? '');
      if (!dim) return [];
      return facetCensus(items, dim.extract(items)).map((t) => ({ label: t.value, value: t.cardCount, cardIds: t.cardIds }));
    },
  },
  {
    key: 'pivot',
    label: 'Aggregate',
    run: (items, desc) => {
      const dim = dimensionDefById(desc.dimension ?? '');
      const m = measureDefById(desc.measure ?? '');
      if (!dim || !m) return `_pivot needs a dimension and a measure_`;
      const agg = aggOf(desc);
      return facetPivotText(items, dim.extract(items), m.measure, agg, heading(desc, `${m.label} by ${dim.label.toLowerCase()} (${agg.label.toLowerCase()})`), m.format);
    },
    rows: (items, desc) => {
      const dim = dimensionDefById(desc.dimension ?? '');
      const m = measureDefById(desc.measure ?? '');
      if (!dim || !m) return [];
      return facetPivot(items, dim.extract(items), m.measure, aggOf(desc)).map((r) => ({ label: r.value, value: r.result, cardIds: r.cardIds }));
    },
  },
  {
    key: 'histogram',
    label: 'Distribution',
    run: (items, desc) => {
      const m = measureDefById(desc.measure ?? '');
      if (!m || !m.buckets) return `_histogram needs a measure with bands_`;
      return bucketDistributionText(items, m.measure, m.buckets, heading(desc, `${m.label} distribution`));
    },
    rows: (items, desc) => {
      const m = measureDefById(desc.measure ?? '');
      if (!m || !m.buckets) return [];
      return bucketDistribution(items, m.measure, m.buckets).map((b) => ({ label: b.label, value: b.count, cardIds: b.cardIds }));
    },
  },
  {
    key: 'crosstab',
    label: 'Matrix',
    run: (items, desc) => {
      const row = dimensionDefById(desc.dimension ?? '');
      const col = dimensionDefById(desc.colDimension ?? '');
      if (!row || !col) return `_crosstab needs two dimensions_`;
      const m = desc.measure ? measureDefById(desc.measure) : null;
      return crossTabText(items, row.extract(items), col.extract(items), heading(desc, `${row.label} × ${col.label.toLowerCase()}`), {
        measure: m?.measure,
        agg: m ? aggOf(desc) : undefined,
        formatValue: m?.format,
      });
    },
    rows: (items, desc) => {
      const row = dimensionDefById(desc.dimension ?? '');
      const col = dimensionDefById(desc.colDimension ?? '');
      if (!row || !col) return [];
      const m = desc.measure ? measureDefById(desc.measure) : null;
      return crossTab(items, row.extract(items), col.extract(items), m?.measure, m ? aggOf(desc) : undefined).cells
        .map((c) => ({ label: `${c.row} × ${c.col}`, value: c.value, cardIds: c.cardIds }));
    },
  },
];
export function reductionDefByKey(key: string): ReductionDef | null {
  return REDUCTIONS.find((r) => r.key === key) ?? null;
}

/**
 * Run a report descriptor over a board → its markdown. Blind: it resolves the reduction/dimension/measure by
 * DATA key and dispatches; unknown keys return an honest `_..._` note (never throws). ANY valid combination is
 * a report with zero new code.
 */
export function runReport(items: readonly BoardItem[], desc: ReportDescriptor): string {
  const reduction = reductionDefByKey(desc.reduction);
  return reduction ? reduction.run(items, desc) : `_unknown reduction "${desc.reduction}"_`;
}

/**
 * The STRUCTURED result of a report — the common `ReportRow[]` shape (label + value + cardIds) across all four
 * reductions. `runReport`'s markdown is a rendering of these; this returns them raw so a threshold predicate or
 * a board selection can act on them. Unknown/underspecified descriptor → `[]` (mirrors the text runner's note).
 */
export function reportRows(items: readonly BoardItem[], desc: ReportDescriptor): ReportRow[] {
  const reduction = reductionDefByKey(desc.reduction);
  return reduction ? reduction.rows(items, desc) : [];
}

/**
 * The ANALYSIS → ACTION bridge: the deduped card ids of every report row the `predicate` keeps. "Select the
 * cards in tags averaging under 50% progress" is `reportSelect(items, {reduction:'pivot', dimension:'tag',
 * measure:'progress'}, r => r.value !== null && r.value < 0.5)`. A card in several kept groups is returned once
 * (first-seen order). Pure — turns any report into a board selection with zero per-report code.
 */
export function reportSelect(
  items: readonly BoardItem[],
  desc: ReportDescriptor,
  predicate: (row: ReportRow) => boolean,
): string[] {
  const ids = new Set<string>();
  for (const row of reportRows(items, desc)) {
    if (!predicate(row)) continue;
    for (const id of row.cardIds) ids.add(id);
  }
  return [...ids];
}
