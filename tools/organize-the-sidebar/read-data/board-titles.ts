// packages/group/read-data/board-titles.ts
//
// DUPLICATE TITLES — reference-integrity for the board's `[[wikilink]]` system. A card's TITLE is its first
// line (card-references SSOT), and `[[Title]]` resolves to the card so titled. But `buildTitleIndex` maps a
// normalized title to the FIRST card bearing it (first-wins) — so when TWO cards share a title, every
// `[[link]]` to it silently lands on the first and the SECOND becomes UNREACHABLE by reference: a "shadowed"
// card. That is a real, invisible bug on a research / vision board (rename a card to match another and its
// backlinks quietly break). This surfaces the collisions so "which of my cards have ambiguous titles?" and
// "select the duplicate-title cards to rename/merge" fall out.
//
// Distinct from the rest of the reference family — b139 resolves refs, b140 creates cards for BROKEN refs
// (`[[Title]]` naming no card); this is the third member: AMBIGUOUS targets (a title naming MORE THAN one
// card). It composes the title SSOT EXACTLY (`cardTitle` + `normalizeTitle` + the same first-wins order +
// the same empty-title guard as `buildTitleIndex`), so `shadowedTitleIds` is provably the set of cards that
// lose the live resolution race — never a parallel notion of "title". Pure, deterministic (board order), no I/O.

import type { BoardItem } from './group-board-model.ts';
import { cardTitle, normalizeTitle } from './card-references.ts';

/** A set of cards that share one normalized title — the collision. `memberIds` are in BOARD ORDER, so
 *  `memberIds[0]` is the card `buildTitleIndex` resolves `[[Title]]` to (the "reachable" one) and the rest
 *  are shadowed (unreachable by reference). Only emitted for a title borne by ≥2 cards. */
export interface DuplicateTitleGroup {
  /** The title in its first-seen DISPLAY form (as the winning card typed it), trimmed. */
  readonly title: string;
  /** The normalized key `[[link]]` resolution actually matches on (case/whitespace-folded). */
  readonly key: string;
  /** Every card bearing this title, in board order — `[0]` reachable, `[1..]` shadowed. */
  readonly memberIds: readonly string[];
}

/** Every title borne by ≥2 cards → its colliding group, in the order each title first appears on the board.
 *  Untitled cards (empty first line) share the '' key and are NOT a collision — excluded by the same guard
 *  `buildTitleIndex` uses (key length > 0), so this stays byte-consistent with live `[[link]]` resolution. */
export function duplicateTitleGroups(items: readonly BoardItem[]): DuplicateTitleGroup[] {
  // First pass — group card ids by normalized key, remembering each key's first display title + first order.
  const byKey = new Map<string, { title: string; ids: string[] }>();
  for (const it of items) {
    const display = cardTitle(it);
    const key = normalizeTitle(display);
    if (key.length === 0) continue; // untitled (or text-less, e.g. a connector) — never a title collision
    const bucket = byKey.get(key);
    if (bucket) bucket.ids.push(it.memberId);
    else byKey.set(key, { title: display, ids: [it.memberId] });
  }
  // Second pass — keep only the ≥2 buckets; Map preserves first-insertion order → groups in title-appearance order.
  const out: DuplicateTitleGroup[] = [];
  for (const [key, { title, ids }] of byKey) {
    if (ids.length >= 2) out.push({ title, key, memberIds: ids });
  }
  return out;
}

/** The SHADOWED cards — the 2nd-and-later card of every collision, sorted. These are exactly the cards a
 *  `[[Title]]` can NEVER reach (the first card wins), so their backlinks are silently broken. The actionable
 *  subset: rename or merge these to restore reference reachability. */
export function shadowedTitleIds(items: readonly BoardItem[]): string[] {
  const out: string[] = [];
  for (const g of duplicateTitleGroups(items)) out.push(...g.memberIds.slice(1));
  return out.sort();
}

/** Every card in ANY collision — winner AND shadowed, sorted. The "Select duplicate-title cards" set: the
 *  user wants to see BOTH sides of each ambiguous title to decide which to rename. */
export function ambiguousTitleIds(items: readonly BoardItem[]): string[] {
  const out: string[] = [];
  for (const g of duplicateTitleGroups(items)) out.push(...g.memberIds);
  return out.sort();
}

/** True iff any title is borne by ≥2 cards — the gate for surfacing the select/export affordance (L118). */
export function boardHasDuplicateTitles(items: readonly BoardItem[]): boolean {
  return duplicateTitleGroups(items).length > 0;
}

/** Render the collisions as a report: a "## Duplicate titles (N)" header + one line per colliding title with
 *  its card count and how many are shadowed (unreachable). "No duplicate titles" when none. */
export function duplicateTitlesText(items: readonly BoardItem[], title?: string): string {
  const groups = duplicateTitleGroups(items);
  const head: string[] = title && title.trim() !== '' ? [`# ${title.trim()}`, ''] : [];
  if (groups.length === 0) return [...head, 'No duplicate titles'].join('\n');
  const lines = groups.map((g) => {
    const shadowed = g.memberIds.length - 1; // all but the reachable first
    return `- ${g.title} — ${g.memberIds.length} cards (${shadowed} unreachable by [[link]])`;
  });
  return [...head, `## Duplicate titles (${groups.length})`, ...lines].join('\n');
}
