// packages/group/show/board-search.ts
//
// The board's free-text search leaf — pure, zero I/O. Whiteboard canon (Mural "Find",
// Craft, Miro): a query keeps MATCHING items bright and dims the rest. This leaf is the
// match predicate; the panel reuses the #119 `CanvasNode.opacity` dim and combines this
// with the tag filter through one focus conjunction (an item is focused iff it passes
// EVERY active filter). The board owns no item-kind knowledge — the haystack is built
// from self-describing fields (text + tags + label) any item may carry.

/** A board item, viewed only for its searchable surface (kinds are never named). */
interface ItemLike {
  text?: string | undefined;
  extra?: Record<string, unknown> | undefined;
}

/** The lowercased searchable text for an item: its human text + tags + label. Never
 *  throws; missing fields contribute nothing. */
export function searchHaystack(item: ItemLike | undefined): string {
  if (!item) return '';
  const parts: string[] = [];
  if (typeof item.text === 'string') parts.push(item.text);
  const tags = item.extra?.tags;
  if (Array.isArray(tags)) for (const t of tags) if (typeof t === 'string') parts.push(t);
  const label = item.extra?.label;
  if (typeof label === 'string') parts.push(label);
  return parts.join(' ').toLowerCase();
}

/**
 * Does an item match the search query? An EMPTY / whitespace-only query matches
 * everything (no search active). Otherwise a case-insensitive substring test of the
 * trimmed query against the item's haystack (text + tags + label).
 */
export function matchesSearch(item: ItemLike | undefined, query: string): boolean {
  const q = (query ?? '').trim().toLowerCase();
  if (q === '') return true;
  return searchHaystack(item).includes(q);
}
