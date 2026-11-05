// packages/group/do-work/board-tag-canonicalize.ts
//
// UNIFY NEAR-DUPLICATE TAGS — the MUTATION that completes the b152 tag-hygiene detector. b152 finds the
// fragmented spellings (`to-do` / `to do` / `todo` = one intent split across three chips); this rewrites every
// card onto ONE canonical spelling in a single batch, so a facet filter stops splitting the intent. Detect →
// select was b152's review surface; this is the one-click FIX.
//
// The canonical spelling per group is the DATA's own choice, not an arbitrary pick: the variant carried by the
// MOST cards wins (tie → alphabetically first), so unifying moves the fewest cards and keeps the spelling the
// user already preferred. Composes the b152 hygiene SSOT (`nearDuplicateTagGroups` + `tagUsage`) + the tag
// normalization SSOT (`normTag`, L069/L093 — owns no tag logic). Pure, deterministic; the per-card rewrite
// de-dupes so a card tagged BOTH `to-do` and `todo` collapses to one canonical tag.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { nearDuplicateTagGroups, tagUsage } from './board-tag-hygiene.ts';
import { normTag } from './tag-cooccurrence.ts';

/** normalized-variant-tag → canonical DISPLAY spelling. Every spelling in a near-duplicate group maps to the
 *  group's most-used spelling. A tag with no near-duplicate is absent from the map (left untouched). */
export function canonicalTagMap(items: readonly BoardItem[]): Map<string, string> {
  const usage = tagUsage(items);
  const map = new Map<string, string>();
  for (const group of nearDuplicateTagGroups(items)) {
    // Each display spelling in the group → its (normTag, card count). Pick the most-used, tie → alpha-first.
    const variants = group.tags.map((display) => {
      const norm = normTag(display);
      return { display, norm, count: usage.get(norm)?.count ?? 0 };
    });
    const canonical = [...variants].sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))[0].display;
    for (const v of variants) map.set(v.norm, canonical);
  }
  return map;
}

/** Rewrite ONE card's tag list onto the canonical spellings: each tag whose normalized form is in `map` becomes
 *  the canonical display; the result is de-duped by normalized form (first occurrence wins) so a card carrying
 *  two spellings of one intent collapses to a single tag. Order preserved. A tag not in the map is untouched. */
export function canonicalizeTags(tags: readonly string[], map: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const norm = normTag(raw);
    const display = map.get(norm) ?? raw;
    const key = normTag(display);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(display);
  }
  return out;
}

/** True iff `next` is the same tag list as `cur` (same order + spelling) — lets a batch skip an unchanged card. */
export function tagsEqual(cur: readonly string[], next: readonly string[]): boolean {
  return cur.length === next.length && cur.every((t, i) => t === next[i]);
}
