// packages/group/read-data/board-cooccurrence.ts
//
// CO-OCCURRENCE / AFFINITY — which two values of a facet keep showing up on the SAME card. b166's facetCensus
// counts each value ALONE (how many cards are Blue); this counts each value with EVERY OTHER (how many cards are
// both `design` AND `urgent`) — the relationship-discovery layer over the same facets. It answers "what goes
// together?": the tags that co-tag, the entities that co-mention, the colours that co-appear. From that fall out
// "related tags" suggestions, affinity clusters, and the strongest recurring combination on the board.
//
// It is the SAME injected-capability shape as facetCensus — a blind reducer over an INJECTED `(item)=>string[]`
// extractor (the exact shape of every `BOARD_ITEM_FACETS` entry). Pass `itemTags` → tag affinity; pass
// `colorFamily` → colour co-appearance; pass an entity extractor → co-mention. A NEW dimension is a NEW extractor,
// ZERO change here (L069/L090). The deletion test (made a test below): co-occurrence over a never-coded dimension
// tallies with zero engine change — the mark of the primitive vs a one-tag-only solution.
//
// A pair is UNORDERED and canonical (`a` < `b` by locale) so {design,urgent} and {urgent,design} are ONE pair.
// A card contributes a pair once per DISTINCT unordered pair of its DISTINCT values (a card tagged
// [x,y,x] yields only {x,y}). Cards with <2 distinct values impose no pair. Pure, deterministic (sorted by
// shared-card count desc, then a asc, then b asc), connectors/furniture excluded.

import type { BoardItem } from './group-board-model.ts';
import { itemIsConnector } from './group-board-model.ts';
import { itemIsBoardFurniture } from '../do-work/batch-actions.ts';
import { COOCCURRENCE_MEASURES, measureById, type CoOccurrenceMeasure } from '../do-work/tag-cooccurrence.ts';

/** An unordered pair of facet values and the content cards carrying BOTH. `a` < `b` (canonical order);
 *  `cardCount === cardIds.length` always. */
export interface PairTally {
  readonly a: string;
  readonly b: string;
  readonly cardCount: number;
  readonly cardIds: readonly string[];
}

/** A facet value extractor — the item's value(s) on one dimension (the shape of every `BOARD_ITEM_FACETS` entry). */
export type FacetExtract = (item: BoardItem) => readonly string[];

/** Content card = not a connector and not generated furniture (only these carry co-occurring values). */
function contentCards(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i));
}

/** The DISTINCT values a card carries, sorted (so pairs form in canonical order deterministically). */
function distinctValues(card: BoardItem, extract: FacetExtract): string[] {
  return [...new Set(extract(card))].sort((x, y) => x.localeCompare(y));
}

const pairKey = (a: string, b: string): string => `${a}\u0000${b}`; // NUL-joined — a NUL cannot occur in a facet value, so distinct pairs never collide

/** Every co-occurring value pair on the board with the cards carrying both, sorted shared-count desc then a,b asc.
 *  A card with <2 distinct values contributes nothing. Blind over the injected extractor (L069/L090). */
export function cooccurrence(items: readonly BoardItem[], extract: FacetExtract): PairTally[] {
  const byPair = new Map<string, { a: string; b: string; cardIds: string[] }>();
  for (const card of contentCards(items)) {
    const values = distinctValues(card, extract);
    for (let i = 0; i < values.length; i += 1) {
      for (let j = i + 1; j < values.length; j += 1) {
        const a = values[i];
        const b = values[j]; // a < b by construction (values is sorted)
        const key = pairKey(a, b);
        const entry = byPair.get(key);
        if (entry) entry.cardIds.push(card.memberId);
        else byPair.set(key, { a, b, cardIds: [card.memberId] });
      }
    }
  }
  return [...byPair.values()]
    .map((e) => ({ a: e.a, b: e.b, cardCount: e.cardIds.length, cardIds: e.cardIds }))
    .sort((p, q) => q.cardCount - p.cardCount || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
}

/** The single strongest pair (most shared cards; ties broken a then b asc), or null when no pair exists. */
export function topPair(items: readonly BoardItem[], extract: FacetExtract): PairTally | null {
  const pairs = cooccurrence(items, extract);
  return pairs.length > 0 ? pairs[0] : null;
}

/** The values that co-occur with a given value, ranked by shared-card count desc then value asc — the
 *  "related to X" affinity list (e.g. the tags that keep appearing alongside `design`). */
export function valuesRelatedTo(
  items: readonly BoardItem[],
  extract: FacetExtract,
  value: string,
): { readonly value: string; readonly cardCount: number }[] {
  return cooccurrence(items, extract)
    .filter((p) => p.a === value || p.b === value)
    .map((p) => ({ value: p.a === value ? p.b : p.a, cardCount: p.cardCount }))
    .sort((x, y) => y.cardCount - x.cardCount || x.value.localeCompare(y.value));
}

/** The ids of the content cards carrying BOTH values of a pair (sorted), order-independent. */
export function cardIdsForPair(items: readonly BoardItem[], extract: FacetExtract, a: string, b: string): string[] {
  const [lo, hi] = a.localeCompare(b) <= 0 ? [a, b] : [b, a];
  const tally = cooccurrence(items, extract).find((p) => p.a === lo && p.b === hi);
  return tally ? [...tally.cardIds].sort() : [];
}

/** The ids of the cards carrying the STRONGEST pair (sorted), or [] when no pair exists — the "Select the
 *  strongest tag pair" set. */
export function cardIdsForTopPair(items: readonly BoardItem[], extract: FacetExtract): string[] {
  const top = topPair(items, extract);
  return top === null ? [] : [...top.cardIds].sort();
}

/** Whether ANY co-occurring pair exists — the gate for surfacing the affinity export / bulk action. */
export function boardHasCooccurrence(items: readonly BoardItem[], extract: FacetExtract): boolean {
  return cooccurrence(items, extract).length > 0;
}

/** The affinity as a document block: a heading then `- a + b — N cards` rows (strongest first), or `_none_`
 *  when nothing co-occurs. Generic over the heading so ONE function renders tag affinity, colour affinity … */
export function cooccurrenceText(items: readonly BoardItem[], extract: FacetExtract, heading: string): string {
  const pairs = cooccurrence(items, extract);
  if (pairs.length === 0) return `## ${heading}\n\n_none_`;
  const rows = pairs.map((p) => `- ${p.a} + ${p.b} — ${p.cardCount} ${p.cardCount === 1 ? 'card' : 'cards'}`);
  return `## ${heading}\n\n${rows.join('\n')}`;
}

// ============================================================================
// SCORED co-occurrence (b170) — raw shared-count is only ONE way to read "how related". Two values that BOTH
// appear on most cards co-occur a lot by chance; two rare values that ALWAYS appear together are the real
// signal. The strength measures that capture this — Jaccard (overlap÷union), cosine, raw count, lift (vs
// chance) — are NOT re-derived here: they already live as a DATA catalog in `do-work/tag-cooccurrence`
// (`COOCCURRENCE_MEASURES`, b117), where they scored TAG sets. This composes that SAME catalog over the
// GENERIC, id-carrying engine above — so lift/Jaccard now rank ANY facet's pairs (colour attraction, entity
// co-mention) AND you keep the cards. No measure math is duplicated (L093 reuse); a new measure is still one
// row in the b117 catalog, zero change here (L069/L090).
// ============================================================================

/** A co-occurring pair plus its strength `weight` under a chosen measure (the b117 `CoOccurrenceMeasure`). */
export interface ScoredPair extends PairTally {
  readonly weight: number;
}

export interface ScoredCooccurrenceOptions {
  /** A measure id from `COOCCURRENCE_MEASURES` (default the catalog's first — Jaccard "together", L083). */
  readonly measure?: string;
  /** Override the measure catalog (L083 injected default = the shared b117 catalog). */
  readonly measures?: readonly CoOccurrenceMeasure[];
  /** Drop pairs sharing fewer than this many cards before scoring (default 1 — keep all real pairs). */
  readonly minCount?: number;
  /** Keep only the top-N by weight (default: all). */
  readonly limit?: number;
}

/** Every co-occurring pair scored by the chosen strength measure, ranked weight desc (then count desc, then
 *  a,b asc), non-positive weights dropped. Feeds the measure `weight(co, aTotal, bTotal, n)` from the b117
 *  catalog: `co` = the pair's shared-card count, `aTotal`/`bTotal` = each value's card count (from the census),
 *  `n` = the content-card count. Carries the cardIds throughout (the id-carrying engine's advantage over the
 *  set-based tag scorer). Blind over the injected extractor — colour/entity/tag affinity all fall out. */
export function scoredCooccurrence(
  items: readonly BoardItem[],
  extract: FacetExtract,
  opts: ScoredCooccurrenceOptions = {},
): ScoredPair[] {
  const { measure, measures = COOCCURRENCE_MEASURES, minCount = 1, limit } = opts;
  const m = measureById(measure, measures);
  // Per-value marginal totals (a card counts once per distinct value) + the content-card count n — the
  // denominators the strength measures need. Computed from the same content cards the pairs come from.
  const cards = contentCards(items);
  const n = cards.length;
  const totals = new Map<string, number>();
  for (const card of cards) {
    for (const value of distinctValues(card, extract)) totals.set(value, (totals.get(value) ?? 0) + 1);
  }
  const scored = cooccurrence(items, extract)
    .filter((p) => p.cardCount >= minCount)
    .map((p) => ({ ...p, weight: m.weight(p.cardCount, totals.get(p.a) ?? 0, totals.get(p.b) ?? 0, n) }))
    .filter((p) => p.weight > 0)
    .sort((p, q) => q.weight - p.weight || q.cardCount - p.cardCount || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
  return typeof limit === 'number' ? scored.slice(0, Math.max(0, limit)) : scored;
}

/** The scored affinity as a document block: `- a + b — <weight> (N cards)` rows (strongest first), or `_none_`.
 *  The weight is rounded to 2 dp for a readable doc. Generic over the heading + measure. */
export function scoredCooccurrenceText(
  items: readonly BoardItem[],
  extract: FacetExtract,
  heading: string,
  opts: ScoredCooccurrenceOptions = {},
): string {
  const pairs = scoredCooccurrence(items, extract, opts);
  if (pairs.length === 0) return `## ${heading}\n\n_none_`;
  const rows = pairs.map(
    (p) => `- ${p.a} + ${p.b} — ${p.weight.toFixed(2)} (${p.cardCount} ${p.cardCount === 1 ? 'card' : 'cards'})`,
  );
  return `## ${heading}\n\n${rows.join('\n')}`;
}
