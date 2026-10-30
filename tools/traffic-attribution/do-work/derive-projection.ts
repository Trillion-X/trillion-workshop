// tools/traffic-attribution/do-work/derive-projection.ts
//
// Per-project projection derivation: a traffic-signals aggregate -> addressed
// records + visual-database field/view/action descriptor DATA. Everything
// project-specific (label, conversion metric, dimension) comes from the
// tracked-project registry row (DATA) — this file names no project, no
// source/medium/campaign literal.
//
// The board calls this CLIENT-SIDE over the per-project aggregate it builds from the
// append-only observer-fact fold (groupObserverFactsByProject). There is no
// privileged projection-writer process: derivation happens in the reader. The view
// label is "Traffic & Sources — <project.label>" so the operator always knows which
// project the board shows. Empty aggregate -> honest-empty projection (zero
// fabricated rows, L117).
//
// Pure: no I/O, no clock, no React.

import type { TrackedProject, TrackedProjectDimension } from '../read-data/registry.ts';
import {
  projectTrafficAttribution,
  type TrafficAttributionConfig,
  type TrafficAttributionProjection,
} from '../read-data/traffic-attribution.ts';
import {
  readTrafficSignalsAggregate,
  rowsToFacts,
} from '../read-data/traffic-signals-rollup.ts';
import { isClickIdSignal } from '../read-data/click-ids.ts';

const BOARD_TITLE = 'Traffic & Sources';

/** The primary dimension to break traffic down by (first registry dimension, or source). */
function primaryDimension(project: TrackedProject): TrackedProjectDimension {
  return project.dimensions[0] ?? { id: 'source', label: 'Source' };
}

/**
 * The breakdown dimension to use: the explicit `dimensionId` (the board's switcher) when
 * given, else the project's primary. Label resolves from the project's registry dimension
 * with that id (operator-named), falling back to the id itself — so an EMERGENT signal key
 * (a UTM param the operator added to their URLs, never configured) still shows as a column.
 */
function resolveDimension(project: TrackedProject, dimensionId?: string): TrackedProjectDimension {
  const id = typeof dimensionId === 'string' ? dimensionId.trim() : '';
  if (!id) return primaryDimension(project);
  const named = project.dimensions.find((d) => d.id === id);
  return named ?? { id, label: id };
}

/**
 * The breakdown dimensions AVAILABLE for an aggregate = the signal keys actually present
 * across its observer rows (DATA — emergent, zero config). A new tracking param the operator
 * starts using automatically becomes a selectable breakdown. `source` (the canonical
 * first-touch dimension) is ordered first; the rest alphabetically. Empty/junk → [].
 * An ad click id (read-data/click-ids.ts) is one click per value, so it is never offered.
 */
export function availableDimensionIds(aggregate: unknown): string[] {
  const agg = readTrafficSignalsAggregate(aggregate);
  const seen = new Set<string>();
  for (const row of agg.rows) for (const key of Object.keys(row.signals)) if (!isClickIdSignal(key)) seen.add(key);
  return Array.from(seen).sort((a, b) =>
    a === 'source' ? -1 : b === 'source' ? 1 : a.localeCompare(b));
}

/**
 * Build the attribution config for a project from its registry DATA: Visitors + one
 * conversion column (and its rate) PER tracked outcome (the funnel — e.g. Leads, Purchases).
 * Outcomes are DATA (project.conversionMetrics); a new column is a DATA row, zero code. The
 * FIRST outcome keeps the legacy metric ids ('conversions'/'conv_rate') so single-outcome
 * projects render byte-identically; each additional outcome adds conv_<id> + rate_<id>.
 * Discrimination is native: rowsToFacts stamps outcome[<metric>] per fired metric, so each
 * column counts only its own outcome (a `signup` never lands in the `purchase` column).
 */
export function configForProject(project: TrackedProject, dimensionId?: string, includeRevenue = false): TrafficAttributionConfig {
  const dim = resolveDimension(project, dimensionId);
  // Defensive: the reader guarantees conversionMetrics, but a hand-built TrackedProject
  // (test/direct) may omit it — fall back to the singular conversionMetric so it never throws.
  const outcomes = project.conversionMetrics && project.conversionMetrics.length > 0
    ? project.conversionMetrics
    : [{ id: project.conversionMetric, label: 'Conversions' }];
  const metrics: TrafficAttributionConfig['metrics'] = [
    { id: 'visitors', label: 'Visitors', op: 'countEntities' },
  ];
  outcomes.forEach((o, idx) => {
    const countId = idx === 0 ? 'conversions' : `conv_${o.id}`;
    const rateId = idx === 0 ? 'conv_rate' : `rate_${o.id}`;
    metrics.push({ id: countId, label: o.label, op: 'countEntitiesWhere', path: ['candidate', 'outcome', o.id] });
    // a rate is a fraction (0.5) → percent display so the operator reads "50%" not "0.5"/"1"
    metrics.push({ id: rateId, label: idx === 0 ? 'Conv. rate' : `${o.label} rate`, op: 'ratio', numerator: countId, denominator: 'visitors', format: { style: 'percent', maximumFractionDigits: 1 } });
  });
  // Revenue/ROAS columns appear ONLY when the data carries conversion value (caller's
  // includeRevenue, derived from the aggregate) — emergent, zero clutter when no money flows
  // (L118). Revenue = sum of each observer's value at ['candidate','value'] (the generic
  // sumOverEntities op); Rev / visitor = revenue ÷ visitors. No currency literal lives in code.
  if (includeRevenue) {
    // currency comes from the project DATA (default USD); whole-dollar revenue, 2dp per-visitor.
    const currency = project.currency && project.currency.trim() ? project.currency.trim() : 'USD';
    metrics.push({ id: 'revenue', label: 'Revenue', op: 'sumOverEntities', path: ['candidate', 'value'], format: { style: 'currency', currency, maximumFractionDigits: 0 } });
    metrics.push({ id: 'rev_per_visitor', label: 'Rev / visitor', op: 'ratio', numerator: 'revenue', denominator: 'visitors', format: { style: 'currency', currency, maximumFractionDigits: 2 } });
  }
  return {
    viewId: `traffic-by-${dim.id}`,
    viewLabel: `${BOARD_TITLE} — ${project.label}`,
    dimensionLabel: dim.label,
    dimension: { entitySegmentIndex: 1, dimensionPath: ['observer', 'signal', dim.id] },
    metrics,
  };
}

/**
 * Derive a project's board projection from a traffic-signals aggregate (the board's
 * grouped per-project rows). Returns a visual-database decode input bundle.
 * Empty aggregate yields a labeled view with zero rows (honest empty). The aggregate's
 * rows carry `outcomes` (explicit metrics) + `converted` (metric-less default) — rowsToFacts
 * stamps an outcome fact per metric, so per-outcome columns count correctly with no
 * project-side recompute (the discrimination lives in the generic primitive now).
 */
/**
 * Whether an aggregate carries any conversion VALUE (a row with value > 0). When true, the
 * board adds Revenue + Rev/visitor columns — the money metric appears the instant real value
 * flows and never before (emergent, like the dimension switcher). DATA-driven, no project name.
 */
export function aggregateHasRevenue(aggregate: unknown): boolean {
  return readTrafficSignalsAggregate(aggregate).rows.some((r) => typeof r.value === 'number' && r.value > 0);
}

export function deriveProjection(
  project: TrackedProject,
  aggregate: unknown,
  dimensionId?: string,
): TrafficAttributionProjection {
  const config = configForProject(project, dimensionId, aggregateHasRevenue(aggregate));
  const facts = rowsToFacts(readTrafficSignalsAggregate(aggregate), project.conversionMetric);
  const payload = projectTrafficAttribution(facts, config);
  console.log(`[traffic] projection project=${project.projectId} dimension=${config.dimension.dimensionPath.join('.')} rows=${payload.records.length}`);
  return payload;
}
