// packages/group/read-data/board-mentions.ts
//
// UNLINKED MENTIONS — the Obsidian/Roam "you named this note but didn't link it" primitive. A card whose plain
// text contains ANOTHER card's TITLE verbatim, but has no `[[wikilink]]` to it yet, is an unlinked mention —
// the exact spot to SUGGEST a link. It is the third layer of the board's relationship model, distinct from the
// two shipped ones: connectors are lines you DREW (relationship-graph), references are links you TYPED
// (card-references, `[[…]]`), and unlinked mentions are links you IMPLIED by writing the title in prose.
//
// Pure COMPOSITION of the card-references title SSOT — it owns no title logic (reuses `cardTitle` +
// `buildTitleIndex` + `cardReferences` + `normalizeTitle`, L069/L093). The scan:
//   1. A target's title becomes a token phrase (normalized: lower-case, whitespace-collapsed, edge punctuation
//      stripped) so "Buy a house." mentions the card titled "Buy a house".
//   2. A card's `[[…]]` spans are removed before scanning, so an already-bracketed mention is NOT re-reported.
//   3. A mention is a WHOLE-PHRASE token-subsequence match (word-boundary by construction — "house" never
//      matches inside "housewarming", and "buy a house" must appear contiguously), NEVER a raw substring.
//   4. Self-mentions (a card's own title in its own text) and pairs ALREADY `[[linked]]` (in cardReferences)
//      are dropped — only a genuinely-unlinked mention survives, so the signal is "add a link here", not noise.
// Deterministic (emitted in board order, deduped one per from→to pair). No I/O.

import type { BoardItem } from './group-board-model.ts';
import { cardTitle, normalizeTitle, buildTitleIndex, cardReferences } from './card-references.ts';

/** An unlinked mention: a card whose prose names another card's title without a `[[link]]` — a link to SUGGEST. */
export interface UnlinkedMention {
  readonly from: string; // the card whose text mentions the title
  readonly to: string; // the mentioned (so-titled) card id
  readonly title: string; // the mentioned card's display title (first line)
}

const WIKILINK_SPAN = /\[\[[^[\]]*\]\]/g;

/** Normalized phrase tokens: lower-case + whitespace-collapsed (the title SSOT) then edge-punctuation stripped
 *  per token, so "house." and "house" match and word boundaries fall between tokens. Empty tokens dropped. */
function phraseTokens(s: string): string[] {
  return normalizeTitle(s)
    .split(' ')
    .map((t) => t.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, ''))
    .filter((t) => t.length > 0);
}

/** True iff `needle` appears in `haystack` starting at token `at` (whole-phrase, word-bounded). */
function phraseAt(haystack: readonly string[], at: number, needle: readonly string[]): boolean {
  if (at + needle.length > haystack.length) return false;
  for (let j = 0; j < needle.length; j += 1) if (haystack[at + j] !== needle[j]) return false;
  return true;
}

// One scan per board: the same items array (boards hand their readers one immutable array per state) answers every
// reader (the select set, the gate, the health signals) from the first scan.
const scanned = new WeakMap<readonly BoardItem[], UnlinkedMention[]>();

/** Every unlinked mention on the board — each card's prose scanned for the titles of OTHER cards it does not
 *  already `[[link]]`. Deterministic (board order, one per from→to pair). A card's words are walked once: only the
 *  titles starting with the word at each place are tried there, so a board of n cards costs its words, not n². */
export function unlinkedMentions(items: readonly BoardItem[]): UnlinkedMention[] {
  const known = scanned.get(items);
  if (known) return known;
  const out = scanMentions(items);
  scanned.set(items, out);
  return out;
}

function scanMentions(items: readonly BoardItem[]): UnlinkedMention[] {
  // A title can be shared; buildTitleIndex resolves a normalized title → the FIRST card. Mentions of a shared
  // title point at that same first card (consistent with how a `[[Title]]` reference resolves — same SSOT).
  const index = buildTitleIndex(items);
  // Titleable targets in board order: display title, token phrase and the card a mention of it resolves to.
  const targets: { title: string; toks: string[]; to: string }[] = [];
  const startingWith = new Map<string, number[]>();
  for (const it of items) {
    const title = cardTitle(it);
    const toks = phraseTokens(title);
    if (toks.length === 0) continue;
    const at = targets.push({ title, toks, to: index.get(normalizeTitle(title)) ?? it.memberId }) - 1;
    const list = startingWith.get(toks[0]);
    if (list) list.push(at);
    else startingWith.set(toks[0], [at]);
  }
  if (targets.length === 0) return [];
  const linked = new Set(cardReferences(items).map((r) => `${r.from} ${r.to}`));

  const out: UnlinkedMention[] = [];
  const seen = new Set<string>();
  for (const from of items) {
    const raw = typeof from.text === 'string' ? from.text : '';
    if (raw.length === 0) continue;
    const hay = phraseTokens(raw.replace(WIKILINK_SPAN, ' ')); // strip [[…]] spans first
    if (hay.length === 0) continue;
    const found = new Set<number>();
    for (let i = 0; i < hay.length; i += 1) {
      for (const at of startingWith.get(hay[i]) ?? []) if (!found.has(at) && phraseAt(hay, i, targets[at].toks)) found.add(at);
    }
    // Emitted in board order of the mentioned titles, as one pass over every title in order would.
    for (const at of [...found].sort((a, b) => a - b)) {
      const { to, title } = targets[at];
      if (to === from.memberId) continue; // self-mention
      const pair = `${from.memberId} ${to}`;
      if (linked.has(pair) || seen.has(pair)) continue; // already linked, or already emitted
      seen.add(pair);
      out.push({ from: from.memberId, to, title });
    }
  }
  return out;
}

/** The DISTINCT titles `cardId`'s prose mentions without linking — the input to a "link these" affordance. */
export function unlinkedMentionsFrom(items: readonly BoardItem[], cardId: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of unlinkedMentions(items)) {
    if (m.from !== cardId) continue;
    const key = normalizeTitle(m.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m.title);
  }
  return out;
}

/** The sorted ids of cards that have ≥1 unlinked mention — the "Select cards with unlinked mentions" set. */
export function cardsWithUnlinkedMentions(items: readonly BoardItem[]): string[] {
  return [...new Set(unlinkedMentions(items).map((m) => m.from))].sort();
}

/** True iff the board has any unlinked mention — the gate for surfacing the select/suggest affordance. */
export function boardHasUnlinkedMentions(items: readonly BoardItem[]): boolean {
  return unlinkedMentions(items).length > 0;
}
