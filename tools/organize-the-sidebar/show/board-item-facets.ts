// packages/group/show/board-item-facets.ts
//
// =============================================================================
// PURPOSE — the board's item facet dimensions, for the multi-facet FOCUS filter.
// =============================================================================
//
// The template LIBRARY filter (read-data/collection-search.ts) already runs on the generic
// `facet-filter` engine; this is the SAME engine's SECOND consumer, over live BOARD ITEMS
// instead of library rows (the cont.28 deletion test made real — a new consumer + new
// extractors, ZERO engine change). Each facet is an INJECTED `(item) => string[]` reading a
// self-describing field the board already owns: `tag` (item tags), `color` (the item fill,
// bucketed to a human hue NAME so the chip reads "Blue" not "#2563eb"), and `kind` (the item
// kind). A new focus dimension (author, shape, …) is one more extractor row — no engine change.
//
// The colour bucketing is Society DATA (`HUE_BUCKETS`): a table of hue ranges → a human name.
// The mechanism (find the bucket whose [start,end) contains the hue) is Physics. Red wraps 360,
// expressed as TWO rows (no wraparound special-case) — enum-dissolution over a continuum.
// =============================================================================

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { matchesFacets, type FacetExtractors, type FacetSelection } from '../read-data/facet-filter';
import { matchesSearch } from './board-search';
import { itemTags } from './item-tags';
import { itemFillColor, hueOf } from './item-fill';
import { checklistFromRaw, checklistProgress } from '../read-data/board-checklist';
import { dueDateFromRaw } from '../read-data/board-due-date';

/** A hue range → human colour name. Society DATA: a new named band is ONE row. `[start,end)`
 *  in degrees [0,360). Red is two rows (it wraps 360) so the finder needs no wrap special-case. */
export interface HueBucket {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export const HUE_BUCKETS: readonly HueBucket[] = [
  { name: 'Red', start: 345, end: 360 },
  { name: 'Red', start: 0, end: 15 },
  { name: 'Orange', start: 15, end: 45 },
  { name: 'Yellow', start: 45, end: 70 },
  { name: 'Green', start: 70, end: 165 },
  { name: 'Cyan', start: 165, end: 195 },
  { name: 'Blue', start: 195, end: 255 },
  { name: 'Purple', start: 255, end: 290 },
  { name: 'Pink', start: 290, end: 345 },
];

/** The human colour name for a hue via the DATA bucket table (blind range lookup). */
export function hueBucketName(hue: number): string {
  const h = ((hue % 360) + 360) % 360; // normalize to [0,360)
  const bucket = HUE_BUCKETS.find((b) => h >= b.start && h < b.end);
  return bucket?.name ?? 'Grey';
}

/** The colour-FAMILY facet values for an item: a single human hue name, or 'Grey' for an
 *  achromatic fill, or [] when the item has no fill at all (a colourless note imposes no
 *  colour facet). NOTE the facet key is `colorFamily`, NOT `color` — the live-lens/arrange
 *  registry (`BOARD_FACETS` in saved-arrangement.ts) already owns `color` as the EXACT fill
 *  hex for equality-clustering; this is the human hue BUCKET for focus chips (Codex: never
 *  overload one key with two meanings). */
export function colorFacetOf(item: BoardItem): string[] {
  const fill = itemFillColor(item);
  if (!fill) return [];
  const hue = hueOf(fill);
  return [hue === null ? 'Grey' : hueBucketName(hue)];
}

/** Raw item kind → a human TYPE family. Society DATA: like `colorFamily` buckets many hues to
 *  one name, this buckets the raw item kinds (`image`/`media` → one 'Image' family) to a human
 *  chip label so no raw internal kind ('media') ever surfaces as a control (Codex/L114). A kind
 *  mapped to '' (or absent → Title-cased) is surfaceable; the two below are container/transient
 *  and map to '' so they impose NO type facet (you don't "focus on the group frames"). */
export const KIND_FAMILY: Readonly<Record<string, string>> = {
  note: 'Note',
  image: 'Image',
  media: 'Image',
  link: 'Link',
  frame: 'Frame',
  stamp: 'Stamp',
  section: '', // a group container, not a focusable content type
  pending: '', // a transient loading placeholder
};

/** The human TYPE-family facet values for an item: its mapped family, a Title-cased fallback for
 *  an unmapped kind (so a NEW kind still shows a readable chip, never a raw lowercase key), or []
 *  when the kind maps to '' (container/transient) or is absent. */
export function kindFamilyOf(item: BoardItem): string[] {
  const kind = item.kind;
  if (!kind) return [];
  // OWN-key check only: `kind` is untrusted item DATA. `kind in KIND_FAMILY` also matches INHERITED
  // keys, so kind '__proto__' → true → KIND_FAMILY['__proto__'] is Object.prototype → this returned
  // [Object.prototype] as a facet value, which downstream facet string ops (localeCompare/toLowerCase
  // in distinctTags-style reducers) then crash on. hasOwn routes a prototype-chain kind to the
  // Title-case fallback (a harmless readable chip) instead of a live Object reference.
  if (Object.prototype.hasOwnProperty.call(KIND_FAMILY, kind)) {
    const fam = KIND_FAMILY[kind];
    return fam ? [fam] : [];
  }
  return [kind.charAt(0).toUpperCase() + kind.slice(1)]; // unmapped → Title-case, never a raw key
}

/** The board's item facet map — injected into the generic `facet-filter` engine. `tag`/
 *  `colorFamily`/`kindFamily` read the item's own self-describing fields; the engine names none
 *  of them. Adding a dimension = one extractor row here + one descriptor row below, ZERO panel/
 *  focus-bar code (they iterate this DATA) — the cont.29 primitive's emergence property. */
export const BOARD_ITEM_FACETS: FacetExtractors<BoardItem> = {
  tag: (item) => itemTags(item),
  colorFamily: (item) => colorFacetOf(item),
  kindFamily: (item) => kindFamilyOf(item),
  // PROGRESS — the item's checklist completion bucketed to a human status. A card with NO
  // checklist has no progress → returns [] → it dims when any progress chip is chosen (it can't
  // be "in progress"). Time-independent (a ratio, not a clock), so a pure `(item)=>string[]`
  // extractor fits with zero engine change. 0% = 'Not started', 100% = 'Done', else 'In progress'.
  progress: (item) => {
    const list = checklistFromRaw(item.extra?.checklist);
    if (list.length === 0) return [];
    const f = checklistProgress(list).fraction;
    return [f >= 1 ? 'Done' : f === 0 ? 'Not started' : 'In progress'];
  },
  // DEADLINE — whether the card carries a due date, so you can focus the cards that need
  // scheduling ('No deadline') or the ones on a clock ('Has deadline'). Presence, not urgency,
  // so it stays time-independent (urgency would need `now`, which a pure extractor can't read).
  deadline: (item) => [dueDateFromRaw(item.extra?.dueDate) !== null ? 'Has deadline' : 'No deadline'],
};

/** The facet dimensions the focus bar offers, as DATA (key + human label). A new focus
 *  dimension is one row here + one extractor row above — zero focus-bar/panel code (L069/L090). */
export interface BoardFocusFacet {
  readonly key: string;
  readonly label: string;
}

export const BOARD_FOCUS_FACETS: readonly BoardFocusFacet[] = [
  { key: 'tag', label: 'Tag' },
  { key: 'colorFamily', label: 'Color' },
  { key: 'kindFamily', label: 'Type' },
  { key: 'progress', label: 'Progress' },
  { key: 'deadline', label: 'Deadline' },
];

/** THE one "is this item in focus?" predicate — matches EVERY active facet AND the free-text
 *  search (an empty selection / blank query matches all). ONE SSOT so the board's dim, the found-
 *  count, and the "select focused" bridge can never disagree (was inlined 3× in the panel). */
export function boardFocusMatch(item: BoardItem, facets: FacetSelection, query: string): boolean {
  return matchesFacets(item, facets, BOARD_ITEM_FACETS) && matchesSearch(item, query);
}

/** The member ids of the items currently IN focus — the bridge that turns the read-only focus
 *  (which only dims) into an actionable SELECTION: select these, then arrange / restyle / save as
 *  a collection / share the filtered subset through the board's existing action surface. */
export function focusedItemIds(items: readonly BoardItem[], facets: FacetSelection, query: string): string[] {
  return items.filter((it) => boardFocusMatch(it, facets, query)).map((it) => it.memberId);
}

/** The member ids to HIDE when isolating the focus — every VISIBLE, non-connector item NOT in
 *  focus (connectors and already-hidden items are never touched). The complement `focusedItemIds`
 *  leaves standing; the exact set the "Hide others" isolate action feeds to the setHidden primitive. */
export function nonFocusedVisibleIds(items: readonly BoardItem[], facets: FacetSelection, query: string): string[] {
  const focused = new Set(focusedItemIds(items.filter((it) => !itemIsConnector(it)), facets, query));
  return items
    .filter((it) => !itemIsConnector(it) && it.extra?.hidden !== true && !focused.has(it.memberId))
    .map((it) => it.memberId);
}
