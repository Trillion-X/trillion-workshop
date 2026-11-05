// packages/group/show/item-tags.ts
//
// The board's item-tags leaf — pure, zero I/O. An item carries its themes as
// self-describing DATA on `extra.tags` (a string[]), the same blind `extra.*` family
// as crop / opacity / filter / href. This leaf is the parse + read + reduce + match
// boundary: the panel writes parsed tags, the filter bar reads the distinct set and a
// predicate decides which items the current filter focuses. Zero item-kind awareness.

import { entitiesOfKind } from '../do-work/text-entities.ts';

/** A board item, viewed only for its presentation `extra` bag (kinds are never named). */
interface ItemLike {
  extra?: Record<string, unknown> | undefined;
}

/** Max tags kept per item — a guardrail against paste-bombing, not a feature cap. */
const MAX_TAGS = 24;

/**
 * Parse raw user input (comma/newline separated) into a clean tag list: trimmed,
 * non-empty, de-duplicated case-insensitively (first spelling wins), capped.
 */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of (raw ?? '').split(/[,\n]/)) {
    const t = piece.trim();
    if (t === '') continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Merge new tags INTO an item's existing tags (batch-tag a selection ADDS a theme,
 * never wipes per-item tags): existing first, then any genuinely-new ones, deduped
 * case-insensitively (existing spelling wins), capped. Returns `existing` unchanged
 * when nothing new is added.
 */
export function mergeTags(existing: readonly string[], add: readonly string[]): string[] {
  const seen = new Set(existing.map((t) => t.toLowerCase()));
  const out = [...existing];
  for (const t of add) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** An item's stored tags (an array of non-empty strings), or `[]`. Read guard — the
 *  value was parsed at write time, so reading is presence + element-type filtering. */
export function itemTags(item: ItemLike | undefined): string[] {
  const t = item?.extra?.tags;
  if (!Array.isArray(t)) return [];
  // Cap the READ at MAX_TAGS to match the write path (parseTags/mergeTags). A legit item has ≤ MAX_TAGS
  // tags, but a hostile/corrupted persisted `extra.tags` (a paste-bomb of millions of long strings) would
  // otherwise force unbounded filter/lowercase/sort work in distinctTags/facet paths downstream. Fail closed.
  const out: string[] = [];
  for (const x of t) {
    if (typeof x === 'string' && x.trim() !== '') out.push(x);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Join an item's tags for the text-overlay prefill (the inverse of `parseTags`). */
export function formatTags(tags: readonly string[]): string {
  return tags.join(', ');
}

/**
 * The tags to DISPLAY on a note: its stored `extra.tags` unified with the #hashtags written in its body text
 * (detected via `detectEntities`, the leading '#' stripped so a stored "gardening" and a body "#gardening" are ONE
 * tag). Deduped case-insensitively + capped by `mergeTags`. So writing "#gardening" in a note auto-tags it — the
 * body-text and the stored-tags surfaces stay in agreement without the user re-typing the tag.
 */
export function noteDisplayTags(item: ItemLike | undefined, bodyText: string | undefined): string[] {
  const inline = entitiesOfKind(bodyText ?? '', 'hashtag').map((t) => t.replace(/^#+/, ''));
  return mergeTags(itemTags(item), inline);
}

/**
 * Every distinct tag across all items, sorted alphabetically (case-insensitive). The
 * first-seen spelling of each case-insensitive tag is kept, so the filter bar shows a
 * stable label. This is the data the filter bar renders as toggle chips.
 */
export function distinctTags(items: readonly ItemLike[]): string[] {
  const byKey = new Map<string, string>();
  for (const it of items) {
    for (const t of itemTags(it)) {
      const key = t.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, t);
    }
  }
  return [...byKey.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
