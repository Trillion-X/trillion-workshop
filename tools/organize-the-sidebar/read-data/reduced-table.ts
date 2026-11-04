// packages/group/read-data/reduced-table.ts
//
// REDUCED TABLE — the READABLE + ACTIONABLE shape of the reducer family. The board already owns the reducer
// engines (facet-census b166 = count cards per bucket; facet-pivot b175 = aggregate a measure per bucket;
// measure-bucket b166 = a histogram; crosstab = a 2-D contingency matrix), but they were surfaced ONLY as
// export TEXT (`facetCensusText` / `facetPivotText` / `bucketDistributionText` in board-document-exports).
// There was no on-canvas surface to READ a breakdown and ACT on a group. This is that shape: a flat list of
// SECTIONS, each a titled set of GROUPS, each group carrying the exact cards it holds — so a blind panel
// (`show/ReducedTablePanel`) can render any reducer's output identically and turn every group into a
// click-to-select control. The panel names no reducer; the reducer names no panel (L069/L090/L098).
//
// This file owns ONLY the shape + the census→table adapter. Pivot / histogram / crosstab adapters are the
// SAME shape from a different reducer (one adapter each, zero panel change) — the emergence property.
//
// Pure + deterministic (no clock, no randomness): the same items + facets always reduce to the same table.

import type { BoardItem } from './group-board-model';
import { facetCensus, type FacetExtract } from './board-facet-census';

/** One group within a section: a human label, the aggregate rendered as text (a count, an average, …), and
 *  the exact cards the group holds. `cardIds` is the click-to-select payload — the panel never recomputes it. */
export interface ReducedGroup {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly cardIds: readonly string[];
}

/** One titled section — one reducer dimension (a facet like Tag, or a measure like Progress). Groups are
 *  pre-sorted by the adapter (the census sorts most-cards-first); the panel renders them in the given order. */
export interface ReducedSection {
  readonly key: string;
  readonly title: string;
  readonly groups: readonly ReducedGroup[];
}

/** A whole breakdown: zero or more sections. Empty = nothing worth breaking down (no dimension has ≥2 groups). */
export interface ReducedTable {
  readonly sections: readonly ReducedSection[];
}

/** A facet dimension to break down by: a stable key, a human title, and the value extractor (the exact shape
 *  of a `BOARD_ITEM_FACETS` entry, labeled). The adapter names none of these — the caller injects the catalog. */
export interface LabeledFacet {
  readonly key: string;
  readonly title: string;
  readonly extract: FacetExtract;
}

/** True when the table has nothing to show — no dimension produced a section (every facet had <2 values). */
export function reducedTableIsEmpty(table: ReducedTable): boolean {
  return table.sections.length === 0;
}

/** Total groups across all sections — the count of clickable rows the panel will render. */
export function reducedTableGroupCount(table: ReducedTable): number {
  return table.sections.reduce((n, s) => n + s.groups.length, 0);
}

/**
 * The CENSUS adapter: reduce the board to a breakdown table by counting cards per value of each facet.
 *
 * For each injected facet dimension, run the shared `facetCensus` (count cards per distinct value, most-first).
 * A dimension becomes a SECTION only when it has ≥2 distinct values — a single-value facet ("everything is one
 * tag") is not a useful breakdown, it is a constant (this mirrors the Diversity lens's ≥2 gate, L118). Each
 * census tally becomes a GROUP: label = the value, detail = the card count, cardIds = the cards carrying it.
 *
 * Owns no facet, no field, no vocabulary — the `facets` catalog is injected; a new dimension is one more row
 * at the call site, ZERO change here (L069). The panel that renders the result is equally blind.
 */
export function censusReducedTable(items: readonly BoardItem[], facets: readonly LabeledFacet[]): ReducedTable {
  const sections: ReducedSection[] = [];
  for (const facet of facets) {
    const tally = facetCensus(items, facet.extract);
    if (tally.length < 2) continue; // <2 values → not a breakdown, skip the section
    sections.push({
      key: facet.key,
      title: facet.title,
      groups: tally.map((t) => ({
        key: `${facet.key}:${t.value}`,
        label: t.value,
        detail: String(t.cardCount),
        cardIds: t.cardIds,
      })),
    });
  }
  return { sections };
}
