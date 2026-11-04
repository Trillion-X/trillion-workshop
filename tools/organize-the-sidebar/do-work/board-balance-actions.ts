// packages/group/do-work/board-balance-actions.ts
//
// The row-builder for the BALANCE surface: turns the facet-balance leaf (board-facet-balance) into per-facet
// rows for the panel. "Is my board 80% one tag / one colour?" — a design signal a vision board wants (an evenness
// number per facet + the dominant value's share). Owns NO balance math (`facetBalance`/`distributionBalance`) and
// NO facet reading (`facetCensus`) — pure composition (L069/L093); the facet LIST is injected (label + extractor),
// so this stays blind to which dimensions exist (L098). A facet with fewer than 2 distinct values has no
// distribution to balance, so it is dropped (no meaningless "100% dominated" row, L118). Deterministic.

import type { BoardItem } from '../read-data/group-board-model';
import { type FacetExtract, facetCensus } from '../read-data/board-facet-census';
import { facetBalance, evennessBandOf } from '../read-data/board-facet-balance';

/** One facet's balance, ready to render: the human facet label, its evenness band, the numbers, and the
 *  dominant value's name + share. */
export interface BalanceRow {
  readonly key: string;
  readonly label: string;
  /** Evenness band label ("Even" / "Mixed" / "Dominated"). */
  readonly band: string;
  readonly evenness: number;
  readonly topShare: number;
  readonly distinct: number;
  readonly dominant: string;
  /** How many cards carry the dominant value — the size of the "over-represented" set an action would select. */
  readonly dominantCount: number;
}

/** A facet the balance panel measures — its human label + how to read its values off a card. */
export interface BalanceFacet {
  readonly key: string;
  readonly label: string;
  readonly extract: FacetExtract;
}

/**
 * Balance rows for the injected facets, most-lopsided first (lowest evenness), key tie-break. A facet with <2
 * distinct values (nothing to balance) is dropped. Pure, deterministic.
 */
export function balanceRows(items: readonly BoardItem[], facets: readonly BalanceFacet[]): BalanceRow[] {
  const rows: BalanceRow[] = [];
  for (const f of facets) {
    const census = facetCensus(items, f.extract);
    const bal = facetBalance(items, f.extract);
    if (bal.distinct < 2) continue; // one value (or none) → no distribution to balance
    rows.push({
      key: f.key,
      label: f.label,
      band: evennessBandOf(bal.evenness).label,
      evenness: bal.evenness,
      topShare: bal.topShare,
      distinct: bal.distinct,
      dominant: census[0]?.value ?? '',
      dominantCount: census[0]?.cardCount ?? 0,
    });
  }
  rows.sort((a, b) => (a.evenness - b.evenness) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}
