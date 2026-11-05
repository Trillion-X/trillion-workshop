// packages/group/read-data/board-facet-census.ts
//
// FACET CENSUS — the L069 generalization of every "count the cards per bucket" legend on the board.
// b163 counts connectors per RELATION KIND; a colour legend would count cards per FILL HUE; a type
// census counts cards per KIND FAMILY; a tag census counts cards per TAG. Those are all ONE operation:
// given a way to read a card's value(s) on some dimension, tally the content cards per value. So this
// owns NO dimension — it is a blind reducer over an INJECTED `(item) => string[]` extractor (the exact
// shape of every entry in `BOARD_ITEM_FACETS`). Pass `colorFamily` → a colour legend; pass `kindFamily`
// → a type census; pass `tag` → a tag census; pass `progress`/`deadline` → a status breakdown. A NEW
// dimension (shape, author, …) is a NEW extractor row in the facet catalog — ZERO change here (L090).
//
// The DELETION TEST: delete the colour legend and the type census that call this; the reducer still
// tallies any completely different dimension dropped in as an extractor, zero engine change. That is
// the mark of the primitive vs an instance solution (a hand-rolled `colorLegend(items)` would be clay
// for exactly one hue dimension). Multi-value extractors (tags) are honoured — a card contributes ONCE
// to each DISTINCT value it carries, never twice to the same value. Pure, deterministic (sorted by
// cardCount desc, then value asc), connector/furniture excluded (only content cards carry a facet).

import type { BoardItem } from './group-board-model.ts';
import { itemIsConnector } from './group-board-model.ts';
import { itemIsBoardFurniture } from '../do-work/batch-actions.ts';

/** One value of a facet and the content cards that carry it. `cardCount === cardIds.length` always. */
export interface FacetTally {
  readonly value: string;
  readonly cardCount: number;
  readonly cardIds: readonly string[];
}

/** A facet value extractor: the item's value(s) on one dimension, or [] if it imposes none. This is the
 *  exact shape of every entry in `BOARD_ITEM_FACETS` (show/board-item-facets.ts) — so any facet the board
 *  already offers is a valid census dimension with zero new reader code. */
export type FacetExtract = (item: BoardItem) => readonly string[];

/** Content card = not a connector and not generated furniture (only these carry a facet value). */
function contentCards(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i));
}

/** The census of a board on ONE injected facet dimension: every value the content cards carry, with the
 *  cards that carry it, sorted most-cards-first then value A→Z. A card counts ONCE per distinct value it
 *  carries (a card tagged `["x","x"]` counts once for `x`). Empty when no card imposes any value. */
export function facetCensus(items: readonly BoardItem[], extract: FacetExtract): FacetTally[] {
  const byValue = new Map<string, string[]>();
  for (const card of contentCards(items)) {
    const seen = new Set<string>(); // dedupe a card's own repeated values so it counts once per value
    for (const value of extract(card)) {
      if (seen.has(value)) continue;
      seen.add(value);
      const ids = byValue.get(value);
      if (ids) ids.push(card.memberId);
      else byValue.set(value, [card.memberId]);
    }
  }
  return [...byValue.entries()]
    .map(([value, cardIds]) => ({ value, cardCount: cardIds.length, cardIds }))
    .sort((a, b) => b.cardCount - a.cardCount || a.value.localeCompare(b.value));
}

/** The single value carried by the most cards (ties broken value A→Z, matching the census sort), or null
 *  when no card imposes a value — the target of a "Select the dominant <facet>" bulk action. */
export function topFacetValue(items: readonly BoardItem[], extract: FacetExtract): string | null {
  const census = facetCensus(items, extract);
  return census.length > 0 ? census[0].value : null;
}

/** The ids of the content cards carrying a specific facet value (sorted) — what selecting one legend row picks. */
export function cardIdsForFacetValue(items: readonly BoardItem[], extract: FacetExtract, value: string): string[] {
  const tally = facetCensus(items, extract).find((t) => t.value === value);
  return tally ? [...tally.cardIds].sort() : [];
}

/** The ids of the content cards carrying the DOMINANT value (sorted), or [] when the board imposes no value. */
export function cardIdsForTopFacetValue(items: readonly BoardItem[], extract: FacetExtract): string[] {
  const top = topFacetValue(items, extract);
  return top === null ? [] : cardIdsForFacetValue(items, extract, top);
}

/** How many DISTINCT values the board's content cards carry on this dimension. */
export function distinctFacetValues(items: readonly BoardItem[], extract: FacetExtract): number {
  return facetCensus(items, extract).length;
}

/** Whether ANY content card carries a value on this dimension — the gate for surfacing the legend/action. */
export function boardHasFacet(items: readonly BoardItem[], extract: FacetExtract): boolean {
  return facetCensus(items, extract).length > 0;
}

/** The census as a document block: a heading then `- Value — N cards` rows (most-cards-first), or `_none_`
 *  when the board imposes no value. Generic over the heading so ONE function renders a colour legend, a
 *  type census, a tag census … from the same reducer (the export rows below are one DATA line each). */
export function facetCensusText(items: readonly BoardItem[], extract: FacetExtract, heading: string): string {
  const census = facetCensus(items, extract);
  if (census.length === 0) return `## ${heading}\n\n_none_`;
  const rows = census.map((t) => `- ${t.value} — ${t.cardCount} ${t.cardCount === 1 ? 'card' : 'cards'}`);
  return `## ${heading}\n\n${rows.join('\n')}`;
}
