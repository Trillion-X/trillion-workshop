// packages/group/do-work/board-tag-hygiene.ts
//
// TAG HYGIENE — the health of a board's TAG TAXONOMY. On a tagged board the vocabulary drifts: you write
// `to-do` on some cards and `todo` (or `To Do`) on others, and now a facet filter splits one intent across
// three chips. And a tag used on exactly ONE card is usually a typo or a stray one-off. This surfaces both so
// "unify my tags" and "clean up the one-offs" fall out. The diagnostic COUNTERPART to `facet-filter` /
// `tag-cooccurrence` (which USE the tags): this AUDITS them.
//
// Two signals, both deterministic + threshold-free (no fuzzy edit-distance — a Society-arbitrary cutoff):
//   • NEAR-DUPLICATE tags — distinct normalized tags that collapse to the same LOOSE key (normTag then strip
//     every non-alphanumeric), so `to-do` / `to do` / `todo` are one group. This is the definition of "the
//     same tag ignoring punctuation + spacing", not a similarity guess. A loose key must be ≥2 chars so a
//     stray `c#`→`c` can't masquerade as a duplicate of `c`.
//   • ONE-OFF tags — a tag carried by exactly ONE card (a likely typo / stray).
// Composes the tag SSOT (`itemTags` extraction + `normTag` normalization, L069/L093 — owns no tag logic).
// Pure, deterministic (alphabetical), per-card de-duped. It only SUGGESTS — the user decides what to merge.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { itemTags } from '../show/item-tags.ts';
import { normTag } from './tag-cooccurrence.ts';

/** Per-tag usage, keyed by the normalized tag. `tag` is the first-seen DISPLAY spelling (stable label). */
export interface TagUsage {
  /** The first-seen display spelling of this tag. */
  readonly tag: string;
  /** The normalized key (`normTag`) — how the tag is counted + how `[[facet]]` folds case. */
  readonly key: string;
  /** How many DISTINCT cards carry it. */
  readonly count: number;
  /** The cards carrying it, sorted. */
  readonly cardIds: readonly string[];
}

/** A set of distinct tag spellings that mean the same thing modulo punctuation/spacing — the fragmentation. */
export interface NearDuplicateTagGroup {
  /** The alphanumerics-only key the tags collapse to (`todo` for `to-do`/`to do`/`todo`). */
  readonly looseKey: string;
  /** The distinct display spellings in the group, sorted (≥2). */
  readonly tags: readonly string[];
  /** Every card carrying any spelling in the group, sorted — the "unify these" selection. */
  readonly cardIds: readonly string[];
}

/** The alphanumerics-only collapse of a normalized tag — the near-duplicate key. '' when nothing survives. */
export function looseTagKey(key: string): string {
  return key.replace(/[^a-z0-9]/g, '');
}

/** Per-tag usage across the board, keyed by normalized tag: display spelling + distinct-card count + card ids.
 *  Tags are de-duped WITHIN a card (a card tagged `todo` twice counts once) and across case/#-prefix (normTag). */
export function tagUsage(items: readonly BoardItem[]): Map<string, TagUsage> {
  // Accumulate first-seen display + a card-id set per normalized key.
  const acc = new Map<string, { tag: string; cards: Set<string> }>();
  for (const it of items) {
    const seenThisCard = new Set<string>(); // per-card de-dupe by normalized key
    for (const raw of itemTags(it)) {
      const key = normTag(raw);
      if (key.length === 0 || seenThisCard.has(key)) continue;
      seenThisCard.add(key);
      const bucket = acc.get(key);
      if (bucket) bucket.cards.add(it.memberId);
      else acc.set(key, { tag: raw.trim(), cards: new Set([it.memberId]) });
    }
  }
  const out = new Map<string, TagUsage>();
  for (const [key, { tag, cards }] of acc) {
    out.set(key, { tag, key, count: cards.size, cardIds: [...cards].sort() });
  }
  return out;
}

/** The normalized keys already accounted for as near-duplicate fragmentation — so a one-off that is really a
 *  mis-spelling of another tag is classified as fragmentation (the more useful signal), never double-reported. */
function fragmentedKeys(items: readonly BoardItem[]): Set<string> {
  const keys = new Set<string>();
  for (const g of nearDuplicateTagGroups(items)) for (const t of g.tags) keys.add(normTag(t));
  return keys;
}

/** The tags carried by exactly ONE card AND not part of a near-duplicate group — the true one-offs (likely
 *  typos / strays), by display spelling, sorted. A count-1 tag that is a variant of another (e.g. `to-do` vs
 *  `todo`) is reported by {@link nearDuplicateTagGroups} instead, so the two categories never overlap. */
export function singletonTags(items: readonly BoardItem[]): string[] {
  const fragmented = fragmentedKeys(items);
  const out: string[] = [];
  for (const u of tagUsage(items).values()) if (u.count === 1 && !fragmented.has(u.key)) out.push(u.tag);
  return out.sort((a, b) => a.localeCompare(b));
}

/** The cards carrying ≥1 true one-off tag — the "clean up my stray tags" selection, sorted. */
export function cardsWithSingletonTag(items: readonly BoardItem[]): string[] {
  const fragmented = fragmentedKeys(items);
  const singles = new Set([...tagUsage(items).values()].filter((u) => u.count === 1 && !fragmented.has(u.key)).map((u) => u.key));
  if (singles.size === 0) return [];
  const out = new Set<string>();
  for (const it of items) {
    for (const raw of itemTags(it)) if (singles.has(normTag(raw))) { out.add(it.memberId); break; }
  }
  return [...out].sort();
}

/** Groups of distinct tag spellings that collapse to one loose key (`to-do`/`to do`/`todo`) — the fragmented
 *  taxonomy. Only groups with ≥2 distinct normalized spellings AND a loose key of ≥2 chars are emitted, so a
 *  stray `c#`→`c` never masquerades as a duplicate of `c`. Sorted by loose key. */
export function nearDuplicateTagGroups(items: readonly BoardItem[]): NearDuplicateTagGroup[] {
  const usage = tagUsage(items);
  // Bucket normalized keys by their loose key, keeping the display spelling + union of card ids.
  const byLoose = new Map<string, { tags: Map<string, string>; cards: Set<string> }>();
  for (const u of usage.values()) {
    const loose = looseTagKey(u.key);
    if (loose.length < 2) continue; // too short to responsibly call a duplicate
    const bucket = byLoose.get(loose) ?? { tags: new Map<string, string>(), cards: new Set<string>() };
    bucket.tags.set(u.key, u.tag); // one entry per distinct normalized spelling
    for (const c of u.cardIds) bucket.cards.add(c);
    byLoose.set(loose, bucket);
  }
  const out: NearDuplicateTagGroup[] = [];
  for (const [looseKey, { tags, cards }] of byLoose) {
    if (tags.size < 2) continue; // needs ≥2 DIFFERENT spellings to be a fragmentation
    out.push({
      looseKey,
      tags: [...tags.values()].sort((a, b) => a.localeCompare(b)),
      cardIds: [...cards].sort(),
    });
  }
  return out.sort((a, b) => a.looseKey.localeCompare(b.looseKey));
}

/** The cards carrying a tag that has a near-duplicate sibling — the "unify your taxonomy" selection, sorted. */
export function cardsWithFragmentedTag(items: readonly BoardItem[]): string[] {
  const out = new Set<string>();
  for (const g of nearDuplicateTagGroups(items)) for (const c of g.cardIds) out.add(c);
  return [...out].sort();
}

/** True iff the board has a near-duplicate tag group — gates the "Select near-duplicate tags" affordance (L118). */
export function boardHasFragmentedTags(items: readonly BoardItem[]): boolean {
  return nearDuplicateTagGroups(items).length > 0;
}

/** Render the audit: a "## Tag hygiene" report with a Near-duplicate section (each group → its spellings) and a
 *  One-off section (the singletons). "No tag issues" when the taxonomy is clean. */
export function tagHygieneText(items: readonly BoardItem[], title?: string): string {
  const groups = nearDuplicateTagGroups(items);
  const singles = singletonTags(items);
  const head: string[] = title && title.trim() !== '' ? [`# ${title.trim()}`, ''] : [];
  if (groups.length === 0 && singles.length === 0) return [...head, 'No tag issues'].join('\n');
  const lines: string[] = [...head];
  if (groups.length > 0) {
    lines.push(`## Near-duplicate tags (${groups.length})`);
    for (const g of groups) lines.push(`- ${g.tags.join(' / ')} — ${g.cardIds.length} cards, one intent`);
  }
  if (singles.length > 0) {
    if (groups.length > 0) lines.push('');
    lines.push(`## One-off tags (${singles.length})`);
    for (const t of singles) lines.push(`- ${t}`);
  }
  return lines.join('\n');
}
