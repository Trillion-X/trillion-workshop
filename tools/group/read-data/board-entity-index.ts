// packages/group/read-data/board-entity-index.ts
//
// BOARD ENTITY INDEX — collect ONE kind of inline text entity across EVERY card into a deduped index: which
// distinct values appear, and on which cards. `text-entities` already detects URLs / emails / hashtags /
// phones INSIDE a single note (a blind per-text tokenizer over an injected pattern map); this is the board-wide
// AGGREGATOR over it — "every external link on this board", "every email", "every #hashtag" — a references
// index / contact sheet the board never had.
//
// The engine is KIND-PARAMETRIC, not a URL index: it takes a `kind` string and dispatches through the SAME
// injected `entitiesOfKind` seam, so `boardEntityIndex(items, 'url')` (the flagship links index),
// `boardEntityIndex(items, 'email')` (a contact sheet), and `boardEntityIndex(items, 'hashtag')` all emerge
// from ONE function with ZERO new code per kind (L069/L090 — the deletion test: drop the URL example, pass
// 'email', and the index still works). Document frequency: a value counts once per CARD it appears on, not per
// mention. A pure composition of the entity SSOT (`entitiesOfKind` + `TEXT_ENTITY_PATTERNS`, L093 — owns no
// pattern of its own) + the furniture guard. Pure, deterministic (tally, tie-break by value).

import type { BoardItem } from './group-board-model';
import { itemIsConnector } from './group-board-model';
import { itemIsBoardFurniture } from '../do-work/batch-actions';
import { entitiesOfKind, TEXT_ENTITY_PATTERNS, type EntityPattern } from 'trillion-workshop/tools/organize-the-sidebar/do-work/text-entities.ts';

/** One distinct entity value + how many cards carry it and which (sorted). */
export interface EntityRef {
  readonly value: string;
  readonly cardCount: number;
  readonly cardIds: readonly string[];
}

export interface EntityIndexOptions {
  /** The entity patterns to detect with. Defaults to {@link TEXT_ENTITY_PATTERNS}. */
  readonly patterns?: readonly EntityPattern[];
  /** Cap the returned entities (highest card-count first). Default: all. */
  readonly limit?: number;
}

/** Content card = not a connector and not generated furniture (only these carry meaningful text). */
function contentCards(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i));
}

/** Every distinct value of `kind` across the board, ranked by card-count desc then value asc. Document
 *  frequency — a value counts once per card, however many times that card repeats it. */
export function boardEntityIndex(items: readonly BoardItem[], kind: string, opts: EntityIndexOptions = {}): EntityRef[] {
  const patterns = opts.patterns ?? TEXT_ENTITY_PATTERNS;
  const byValue = new Map<string, string[]>();
  for (const card of contentCards(items)) {
    const text = typeof card.text === 'string' ? card.text : '';
    const seen = new Set(entitiesOfKind(text, kind, patterns)); // unique per card → document frequency
    for (const value of seen) {
      const ids = byValue.get(value);
      if (ids) ids.push(card.memberId);
      else byValue.set(value, [card.memberId]);
    }
  }
  const refs: EntityRef[] = [];
  for (const [value, ids] of byValue) refs.push({ value, cardCount: ids.length, cardIds: [...ids].sort() });
  refs.sort((a, b) => b.cardCount - a.cardCount || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return opts.limit != null ? refs.slice(0, opts.limit) : refs;
}

/** The flat, sorted list of distinct values of `kind` on the board. */
export function boardEntityValues(items: readonly BoardItem[], kind: string, opts: EntityIndexOptions = {}): string[] {
  return boardEntityIndex(items, kind, opts).map((r) => r.value);
}

/** The cards carrying ≥1 entity of `kind` (sorted) — what a "Select cards with a link" action selects. */
export function cardIdsWithEntity(items: readonly BoardItem[], kind: string, opts: EntityIndexOptions = {}): string[] {
  const ids = new Set<string>();
  for (const ref of boardEntityIndex(items, kind, opts)) for (const id of ref.cardIds) ids.add(id);
  return [...ids].sort();
}

/** True when the board carries ≥1 entity of `kind` — the gate for the matching surface. */
export function boardHasEntities(items: readonly BoardItem[], kind: string, opts: EntityIndexOptions = {}): boolean {
  return boardEntityIndex(items, kind, opts).length > 0;
}

/** A human "## <heading>" readout: each value with its card tally, or an honest empty line. */
export function entityIndexText(items: readonly BoardItem[], kind: string, heading: string, opts: EntityIndexOptions = {}): string {
  const refs = boardEntityIndex(items, kind, opts);
  const lines: string[] = [`## ${heading}`];
  if (refs.length === 0) {
    lines.push(`- No ${heading.toLowerCase()}`);
    return lines.join('\n');
  }
  for (const r of refs) lines.push(`- ${r.value} — ${r.cardCount} card${r.cardCount === 1 ? '' : 's'}`);
  return lines.join('\n');
}
