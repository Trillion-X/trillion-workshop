// packages/group/read-data/board-measure-bucket.ts
//
// MEASURE BUCKETING — the adapter that makes a HISTOGRAM a configuration of the census (b166), NOT a new
// engine. A distribution ("how many cards fall in 0–25% / 25–50% / … progress") is the same "count per bucket"
// operation the census already does — the only new thing is turning a CONTINUOUS measure into a discrete band
// label. So this owns exactly that one adapter: `bucketFacet(measure, spec) → FacetExtract`. Feed its result
// to `facetCensus` → a histogram; to `facetPivot` → a bucketed aggregate — ZERO new reducer either way (L069).
//
// A distribution differs from a raw census in PRESENTATION only: bands render in their natural ORDER (not by
// count) and INCLUDE empty bands (a histogram shows the 0-count gap). That order-preserving, zero-filled view
// is `bucketDistribution` — still a pure composition over the census, it just re-projects the tallies onto the
// spec's label order. Pure, deterministic; the engine names no measure or band (all DATA).

import type { BoardItem } from './group-board-model.ts';
import { facetCensus, type FacetExtract } from './board-facet-census.ts';
import type { BoardMeasure } from './board-facet-pivot.ts';

/** A bucket spec: `edges` are ascending INTERIOR boundaries; `labels` names the `edges.length + 1` bands. A
 *  value falls in band i where `edges[i-1] <= v < edges[i]` (half-open): `v < edges[0]` → band 0; `v >= ` the
 *  last edge → the last band. */
export interface BucketSpec {
  readonly edges: readonly number[];
  readonly labels: readonly string[];
}

/**
 * Turn a numeric measure into a `FacetExtract` that emits ONE band label per card — or `[]` when the card
 * carries no measure (it joins no band, exactly as a tagless card joins no tag group; never a fake "0" band).
 * The band is a half-open scan: `v < edges[0]` → `labels[0]`; `edges[i-1] <= v < edges[i]` → `labels[i]`;
 * `v >= ` last edge → the last label. This makes `facetCensus(items, bucketFacet(m, spec))` a histogram and
 * `facetPivot(items, bucketFacet(m, spec), …)` a bucketed aggregate — zero new reducer (L069). Pure.
 */
export function bucketFacet(measure: BoardMeasure, spec: BucketSpec): FacetExtract {
  return (item: BoardItem): readonly string[] => {
    const v = measure(item);
    if (v === null || !Number.isFinite(v)) return [];
    let i = 0;
    while (i < spec.edges.length && v >= spec.edges[i]) i += 1;
    return [spec.labels[i] ?? spec.labels[spec.labels.length - 1] ?? String(i)];
  };
}

/** Build an even-width bucket spec over `[min, max)` with `count` bands, labelled by `fmt` (default `lo–hi`
 *  rounded). A convenience DATA builder for the common even-histogram case — a caller may hand-write any
 *  uneven `BucketSpec` instead. `count` is floored at 1. */
export function evenBuckets(
  min: number,
  max: number,
  count: number,
  fmt: (lo: number, hi: number) => string = (lo, hi) => `${Math.round(lo)}–${Math.round(hi)}`,
): BucketSpec {
  const n = Math.max(1, Math.floor(count));
  const width = (max - min) / n;
  const edges: number[] = [];
  const labels: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const lo = min + width * i;
    const hi = min + width * (i + 1);
    if (i > 0) edges.push(lo);
    labels.push(fmt(lo, hi));
  }
  return { edges, labels };
}

/** One band of a distribution: its label, how many cards fell in it (0 for an empty band), and their ids. */
export interface DistributionBand {
  readonly label: string;
  readonly count: number;
  readonly cardIds: readonly string[];
}

/**
 * The order-preserving, zero-filled distribution of a measure over a bucket spec — a histogram. Composes
 * `facetCensus` over `bucketFacet` (the grouping), then re-projects the tallies onto the spec's label ORDER,
 * filling absent bands with 0 (a histogram shows the gap; the raw census omits zero-count values and sorts by
 * count). Cards with no measure are simply absent from every band. Pure, deterministic.
 */
export function bucketDistribution(
  items: readonly BoardItem[],
  measure: BoardMeasure,
  spec: BucketSpec,
): DistributionBand[] {
  const byLabel = new Map(facetCensus(items, bucketFacet(measure, spec)).map((t) => [t.value, t]));
  return spec.labels.map((label) => {
    const t = byLabel.get(label);
    return { label, count: t?.cardCount ?? 0, cardIds: t?.cardIds ?? [] };
  });
}

/** Render a distribution as a markdown readout — one line per band IN ORDER, with a proportional bar so the
 *  shape reads at a glance. Bar length is scaled to the fullest band (empty board → all zero). */
export function bucketDistributionText(
  items: readonly BoardItem[],
  measure: BoardMeasure,
  spec: BucketSpec,
  heading: string,
): string {
  const bands = bucketDistribution(items, measure, spec);
  const peak = bands.reduce((m, b) => (b.count > m ? b.count : m), 0);
  const lines = bands.map((b) => {
    const bar = peak > 0 ? '█'.repeat(Math.round((b.count / peak) * 12)) : '';
    return `- ${b.label} — ${b.count} ${bar}`.trimEnd();
  });
  return `## ${heading}\n\n${lines.join('\n')}`;
}
