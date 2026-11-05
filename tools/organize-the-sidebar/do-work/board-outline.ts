// packages/group/do-work/board-outline.ts
//
// BOARD OUTLINE — the board's STRUCTURE / table-of-contents primitive (b122). Every analysis so far MEASURES
// the board (tidiness, balance, tag relationships); this one NAVIGATES it: the presentation frames are the
// board's sections, so the outline is "each frame (in story order) + the cards it holds, plus a loose bucket
// for anything outside a frame." A big board becomes a jump-to table of contents.
//
// Pure COMPOSITION of the already-shipped frame leaves (`boardFrames` = frames in presentation order,
// `itemsInsideFrame` = the cards a frame spatially contains, `presentationCaptionOf` = a frame's title) — it
// owns no new geometry. Each card is assigned to the FIRST frame (earliest in the story) that contains it, so a
// card is never listed twice even when frames overlap. Deterministic (reading-order within a section), zero I/O.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { itemIsConnector } from '../read-data/group-board-model.ts';
import { boardFrames, itemsInsideFrame, presentationCaptionOf, presentationFrameOf } from './board-frames.ts';

/** One section of the outline — a frame (or the loose bucket) plus the cards under it. */
export interface OutlineEntry {
  /** The frame's member id, or `null` for the loose bucket (cards in no frame). */
  readonly frameId: string | null;
  /** The frame's caption, a `Section N` fallback, or `Loose cards`. */
  readonly caption: string;
  /** The section's cards, in reading order (top→bottom, then left→right). */
  readonly memberIds: readonly string[];
  readonly cardCount: number;
  /** Position in the outline (frames in presentation order, loose bucket last). */
  readonly order: number;
}

/** Sort cards into a stable reading order (top→bottom, then left→right, id tiebreak). */
function readingOrder(cards: readonly BoardItem[]): BoardItem[] {
  return [...cards].sort((a, b) => a.y - b.y || a.x - b.x || a.memberId.localeCompare(b.memberId));
}

/**
 * The board as a navigable outline: each presentation frame (in story order) with the cards it contains, then a
 * `Loose cards` bucket for any card outside every frame. A card belongs to the EARLIEST-ordered frame that
 * contains it (no double-listing when frames overlap). Empty sections are still listed (a frame you have not
 * filled yet is part of the structure). Connectors and nested frames are never cards. Deterministic.
 */
export function boardOutline(items: readonly BoardItem[]): OutlineEntry[] {
  const frames = boardFrames(items); // presentation order
  const claimed = new Set<string>();
  const entries: OutlineEntry[] = [];
  frames.forEach((frame, i) => {
    const inside = readingOrder(itemsInsideFrame(items, frame).filter((c) => !claimed.has(c.memberId)));
    inside.forEach((c) => claimed.add(c.memberId));
    entries.push({
      frameId: frame.memberId,
      caption: presentationCaptionOf(frame) ?? `Section ${i + 1}`,
      memberIds: inside.map((c) => c.memberId),
      cardCount: inside.length,
      order: i,
    });
  });
  const loose = readingOrder(
    items.filter((i) => !itemIsConnector(i) && presentationFrameOf(i) === null && !claimed.has(i.memberId)),
  );
  if (loose.length > 0) {
    entries.push({ frameId: null, caption: 'Loose cards', memberIds: loose.map((c) => c.memberId), cardCount: loose.length, order: frames.length });
  }
  return entries;
}

/** Total cards accounted for across the outline (every card lands in exactly one section). */
export function outlineCardTotal(entries: readonly OutlineEntry[]): number {
  return entries.reduce((s, e) => s + e.cardCount, 0);
}
