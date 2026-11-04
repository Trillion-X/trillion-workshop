// packages/group/read-data/card-references.ts
//
// CARD CROSS-REFERENCES ("wikilinks") — type `[[Buy a house]]` in a card's text and it becomes a resolved
// reference to the board card TITLED "Buy a house", giving Obsidian/Roam-style backlinks ("what links here?").
// This is DISTINCT from the connector graph (read-data/relationship-graph): connectors are lines you DRAW;
// references are links you TYPE. A card's title is its first line (how mind-map cards are named). Resolution
// is case/whitespace-insensitive and deterministic (first card with a title wins). Pure — no I/O, no DOM.
//
// Composes nothing it shouldn't: the `[[…]]` scan is a board-level concern (resolving to a board card), so it
// lives here rather than in the generic inline `text-entities` tokenizer (which is for navigable URL/email/…
// spans, not board-card resolution). A broken `[[Title]]` (no such card) is surfaced, not silently dropped.

import type { BoardItem } from './group-board-model';

type ReferenceItem = Pick<BoardItem, 'memberId' | 'text'>;

const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g;

/** A resolved reference: the card that TYPED the `[[…]]` → the card it names. */
export interface CardReference {
  readonly from: string; // the card whose text contains the [[…]]
  readonly to: string; // the resolved target card id
  readonly title: string; // the referenced title as typed (trimmed)
}

/** A `[[Title]]` that names no card on the board — the "you linked to something that doesn't exist" signal. */
export interface BrokenReference {
  readonly from: string;
  readonly title: string;
}

/** Case/whitespace-insensitive title key so `[[Buy A House]]` matches a card titled "buy a  house". */
export function normalizeTitle(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A card's TITLE = its first non-empty line (how mind-map / sticky cards are named). '' for a text-less item.
 *  The SSOT for "what is this card called" — the title index, references, and unlinked-mention scan all read it. */
export function cardTitle(item: ReferenceItem): string {
  const t = typeof item.text === 'string' ? item.text : '';
  return (t.split(/\r?\n/, 1)[0] ?? '').trim();
}

/** The `[[Title]]` references typed in a text — the inner titles, trimmed, in order. */
export function wikilinkTitles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const inner = m[1].trim();
    if (inner.length > 0) out.push(inner);
  }
  return out;
}

/** Map a normalized title → the FIRST card id bearing it (reading order → deterministic resolution). */
export function buildTitleIndex(items: readonly ReferenceItem[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const it of items) {
    const key = normalizeTitle(cardTitle(it));
    if (key.length > 0 && !index.has(key)) index.set(key, it.memberId);
  }
  return index;
}

/** Every RESOLVED reference on the board — each card's `[[Title]]` mentions → a directed edge to the card so
 *  titled. Self-links and unresolved titles are dropped; a from→to pair is emitted once (repeated mentions
 *  dedupe). Deterministic (board order). */
export function cardReferences(items: readonly BoardItem[]): CardReference[] {
  const index = buildTitleIndex(items);
  const refs: CardReference[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const text = typeof it.text === 'string' ? it.text : '';
    if (text.length === 0) continue;
    for (const title of wikilinkTitles(text)) {
      const to = index.get(normalizeTitle(title));
      if (!to || to === it.memberId) continue; // unresolved OR a self-reference
      const key = `${it.memberId}\u0000${to}`;
      if (seen.has(key)) continue; // one edge per (from,to) pair
      seen.add(key);
      refs.push({ from: it.memberId, to, title });
    }
  }
  return refs;
}

/** The cards that reference `cardId` — its BACKLINKS / "linked mentions", sorted + deduped. */
export function backlinksOf(refs: readonly CardReference[], cardId: string): string[] {
  return [...new Set(refs.filter((r) => r.to === cardId).map((r) => r.from))].sort();
}

/** The cards `cardId` references (its FORWARD links / outgoing mentions), sorted + deduped. */
export function referencesFrom(refs: readonly CardReference[], cardId: string): string[] {
  return [...new Set(refs.filter((r) => r.from === cardId).map((r) => r.to))].sort();
}

/** The DISTINCT broken-reference titles typed by ONE card — the `[[Title]]`s in `cardId`'s text that name no
 *  card, in first-seen order (case/whitespace-deduped, display form preserved). The input to "create the
 *  cards this one links to" (the Obsidian red-link → new note move). Deterministic. */
export function brokenReferencesFrom(items: readonly BoardItem[], cardId: string): string[] {
  return brokenReferences(items).filter((b) => b.from === cardId).map((b) => b.title);
}

/** BROKEN references — `[[Title]]` mentions that name no card. Deduped per (card, title), deterministic.
 *  The emergent "create the missing card?" signal. */
export function brokenReferences(items: readonly ReferenceItem[]): BrokenReference[] {
  const index = buildTitleIndex(items);
  const out: BrokenReference[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const text = typeof it.text === 'string' ? it.text : '';
    if (text.length === 0) continue;
    for (const title of wikilinkTitles(text)) {
      const key = normalizeTitle(title);
      if (index.has(key)) continue; // resolves → not broken
      const dedupe = `${it.memberId}\u0000${key}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ from: it.memberId, title });
    }
  }
  return out;
}
