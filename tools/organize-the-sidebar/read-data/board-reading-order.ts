// packages/group/read-data/board-reading-order.ts
//
// SPATIAL READING ORDER — the sequence you'd read a board's cards in if it were a page: row band by row band,
// top to bottom, and left to right within a row. Every ordering so far needs STRUCTURE — b165 numbers the
// CONNECTOR tree, b122 outlines the FRAME sections, spatial-nav hops ONE direction. This one needs neither a
// connector nor a frame: it reads pure GEOMTRY, so a freeform board with zero connectors still linearizes into
// a natural order (a slideshow order, a numbered "here's everything, in order" export, a screen-reader path).
//
// The generative kernel is `bandCluster` — 1D GAP CLUSTERING: sort by a number, and start a new band wherever
// the gap to the previous value exceeds a tolerance. That is the L069 primitive the reading order is ONE
// configuration of: band the cards by their vertical centre (a ROW is a run of cards at a similar height), then
// order each row left→right. The SAME kernel bands by the horizontal centre (a COLUMN read), or by any numeric
// field (price bands, time bands) — the deletion test made a test below. It owns NO board vocabulary: it is
// generic over an injected `(t) => number` accessor (the exact injected-capability shape of b166's facetCensus).
// Pure, deterministic (stable tie-break by value then memberId); connectors/furniture excluded.

import type { BoardItem } from './group-board-model';
import { itemIsConnector } from './group-board-model';
import { itemIsBoardFurniture } from '../do-work/batch-actions';
import { cardTitle } from './card-references';

/** 1D gap clustering — the generative kernel. Orders `items` by `valueOf` ascending, then splits into bands
 *  wherever consecutive values differ by MORE than `tolerance`. Each band is itself value-ascending; the bands
 *  are returned top(low)→bottom(high). A non-finite tolerance or ≤0 means "every item is its own band boundary
 *  only when values differ" → tolerance 0 groups exact ties. Generic over any T + numeric accessor. */
export function bandCluster<T>(items: readonly T[], valueOf: (t: T) => number, tolerance: number): T[][] {
  const tol = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0;
  const sorted = [...items].sort((a, b) => valueOf(a) - valueOf(b));
  const bands: T[][] = [];
  let prev: number | null = null;
  for (const item of sorted) {
    const v = valueOf(item);
    if (prev === null || v - prev > tol) bands.push([item]);
    else bands[bands.length - 1].push(item);
    prev = v;
  }
  return bands;
}

/** Content card = not a connector and not generated furniture (only these are things you'd "read"). */
function contentCards(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i));
}

const cy = (i: BoardItem): number => i.y + i.h / 2; // vertical centre — a card's row is where its middle sits
const cx = (i: BoardItem): number => i.x + i.w / 2; // horizontal centre — its column within a row

export interface ReadingOrderOptions {
  /** Two cards whose vertical centres differ by ≤ this are the SAME row (default 40 world units). */
  readonly rowTolerance?: number;
}

const DEFAULT_ROW_TOLERANCE = 40;

/** The board's content cards in reading order (memberIds): row bands top→bottom, each row left→right. A stable
 *  tie-break (x then memberId) makes the order deterministic for two cards at the same point. */
export function readingOrder(items: readonly BoardItem[], opts?: ReadingOrderOptions): string[] {
  const tol = opts?.rowTolerance !== undefined && Number.isFinite(opts.rowTolerance) && opts.rowTolerance >= 0
    ? opts.rowTolerance
    : DEFAULT_ROW_TOLERANCE;
  const rows = bandCluster(contentCards(items), cy, tol);
  return rows.flatMap((row) =>
    [...row]
      .sort((a, b) => cx(a) - cx(b) || a.memberId.localeCompare(b.memberId))
      .map((c) => c.memberId),
  );
}

/** A card's 1-based position in the reading order, or null when it is not a content card / not present. */
export function readingIndexOf(items: readonly BoardItem[], memberId: string, opts?: ReadingOrderOptions): number | null {
  const idx = readingOrder(items, opts).indexOf(memberId);
  return idx === -1 ? null : idx + 1;
}

/** Whether the board has ≥1 content card to read — the gate for surfacing the reading-order export. */
export function boardHasReadingOrder(items: readonly BoardItem[]): boolean {
  return contentCards(items).length > 0;
}

/** The reading order as a document block: a heading then `N. Title` rows in reading sequence, or `_empty_`
 *  when the board has no content card. Titles via the `cardTitle` SSOT (owns no title parsing). */
export function readingOrderText(items: readonly BoardItem[], opts?: ReadingOrderOptions, heading = 'Reading order'): string {
  const order = readingOrder(items, opts);
  if (order.length === 0) return `## ${heading}\n\n_empty_`;
  const byId = new Map(contentCards(items).map((c) => [c.memberId, c]));
  const rows = order.map((id, i) => {
    const title = byId.has(id) ? cardTitle(byId.get(id)!) : '';
    return `${i + 1}. ${title || '(untitled)'}`;
  });
  return `## ${heading}\n\n${rows.join('\n')}`;
}
