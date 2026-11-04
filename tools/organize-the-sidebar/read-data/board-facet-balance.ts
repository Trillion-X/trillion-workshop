// packages/group/read-data/board-facet-balance.ts
//
// FACET BALANCE — is the board DOMINATED by one value of a facet, or evenly spread? b166's facetCensus gives
// the per-value COUNTS; this reduces that whole distribution to a single 0..1 EVENNESS number + the dominant
// share, so "80% of your cards are one tag" becomes a measurable design signal (the distribution analogue of
// board-balance's SPATIAL evenness — that one asks "is the board crammed in one corner?", this asks "is it
// crammed onto one tag/colour/column?").
//
// The generative kernel is `distributionBalance` — a pure measure over ANY list of counts (Pielou's evenness
// J = H / ln(S), the Shannon entropy normalized by the number of nonzero buckets: J=1 perfectly even, J→0 one
// bucket dominates). It owns NO board vocabulary: `facetBalance` feeds it the census counts of an INJECTED
// extractor (the `BOARD_ITEM_FACETS` shape), so tag balance, colour balance, column balance, and cluster-size
// balance all fall out of ONE measure — the deletion test made a test below (a never-coded number list balances
// with zero engine change). Pure, deterministic, NaN-safe.

import type { BoardItem } from './group-board-model';
import { facetCensus, type FacetExtract } from './board-facet-census';

/** A distribution reduced to its balance: `evenness` 0..1 (1 = perfectly even, 0 = one bucket dominates),
 *  `topShare` 0..1 (the largest bucket's fraction), `distinct` nonzero buckets, `total` sum. */
export interface DistributionBalance {
  readonly evenness: number;
  readonly topShare: number;
  readonly distinct: number;
  readonly total: number;
}

/** Pielou evenness + dominance over a list of counts. Ignores non-positive counts. A single nonzero bucket is
 *  maximally concentrated → evenness 0, topShare 1 (there is no wraparound `ln(1)=0` division: distinct<=1 is
 *  handled before the entropy step). Empty / all-zero → a zeroed result (no NaN). */
export function distributionBalance(counts: readonly number[]): DistributionBalance {
  const positives = counts.filter((c) => Number.isFinite(c) && c > 0);
  const total = positives.reduce((s, c) => s + c, 0);
  if (total === 0) return { evenness: 0, topShare: 0, distinct: 0, total: 0 };
  const distinct = positives.length;
  const topShare = Math.max(...positives) / total;
  if (distinct <= 1) return { evenness: 0, topShare, distinct, total };
  let h = 0;
  for (const c of positives) {
    const p = c / total;
    h -= p * Math.log(p);
  }
  const evenness = Math.min(1, Math.max(0, h / Math.log(distinct))); // clamp float drift into [0,1]
  return { evenness, topShare, distinct, total };
}

/** The balance of the board on ONE injected facet dimension — feeds the census counts to `distributionBalance`.
 *  Blind over the extractor (L069/L090): pass `colorFamily`/`kindFamily`/`itemTags`/… for that facet's balance. */
export function facetBalance(items: readonly BoardItem[], extract: FacetExtract): DistributionBalance {
  return distributionBalance(facetCensus(items, extract).map((t) => t.cardCount));
}

/** A human band for an evenness score. Society DATA (a new band is one row); the finder is blind (first band
 *  whose `minEvenness` the score clears, scanning highest-first). */
export interface EvennessBand {
  readonly key: string;
  readonly label: string;
  readonly minEvenness: number;
}

export const EVENNESS_BANDS: readonly EvennessBand[] = [
  { key: 'even', label: 'Even', minEvenness: 0.75 },
  { key: 'mixed', label: 'Mixed', minEvenness: 0.4 },
  { key: 'dominated', label: 'Dominated', minEvenness: 0 },
];

/** The band an evenness score falls in (highest-clearing band; always resolves — the last band is minEvenness 0). */
export function evennessBandOf(evenness: number, bands: readonly EvennessBand[] = EVENNESS_BANDS): EvennessBand {
  const e = Number.isFinite(evenness) ? evenness : 0;
  return bands.find((b) => e >= b.minEvenness) ?? bands[bands.length - 1];
}

/** The facet balance as a document block: the band + evenness + the dominant value's share, or `_empty_` when
 *  the board imposes no value on this facet. Generic over the heading (one function → tag balance, colour
 *  balance, …). Composes `facetCensus` for the dominant value's name (owns no facet reading). */
export function facetBalanceText(items: readonly BoardItem[], extract: FacetExtract, heading: string): string {
  const census = facetCensus(items, extract);
  if (census.length === 0) return `## ${heading}\n\n_empty_`;
  const bal = distributionBalance(census.map((t) => t.cardCount));
  const band = evennessBandOf(bal.evenness);
  const pct = Math.round(bal.topShare * 100);
  return `## ${heading}\n\n${band.label} — evenness ${bal.evenness.toFixed(2)}; top "${census[0].value}" is ${pct}% of ${bal.total} across ${bal.distinct} ${bal.distinct === 1 ? 'value' : 'values'}`;
}
