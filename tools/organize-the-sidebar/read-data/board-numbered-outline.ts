// packages/group/read-data/board-numbered-outline.ts
//
// NUMBERED OUTLINE — the board's connector tree as a decimal-numbered outline (1, 1.1, 1.2, 2, …), the way a
// spec / agenda / table-of-contents is numbered. `mindMapOutline` already walks the connectors into an ordered
// { depth, text } outline; this adds the LEGAL NUMBERING on top (and exposes the number of any one card, for a
// cross-reference like "see 2.3"). Distinct from the OPML export (XML interchange) and the plain indented
// outline — same tree, a numbering scheme.
//
// A pure composition of `mindMapOutline` (the connector-tree walk SSOT, L069/L093 — owns no tree logic) over
// the WHOLE board's content cards; the numbering is a stateful counter over the depth sequence. Pure,
// deterministic.

import type { BoardItem } from './group-board-model';
import { itemIsConnector } from './group-board-model';
import { itemIsBoardFurniture, mindMapOutline } from '../do-work/batch-actions';

/** One numbered outline row: its legal number, its depth, its text, and (when walked from real board members)
 *  the card's memberId — so an interactive outline can jump to the card without a fragile text match. */
export interface NumberedLine {
  readonly number: string;
  readonly depth: number;
  readonly text: string;
  readonly memberId?: string;
}

/** The content-card ids of the board (connectors + furniture excluded) — the population the outline walks. */
function contentCardIds(items: readonly BoardItem[]): string[] {
  return items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i)).map((i) => i.memberId);
}

/** Assign a decimal number to each outline line from its depth: same depth increments, deeper starts a new
 *  sub-level at 1, shallower truncates back. Robust to a skipped level (pads with 0). Pure. */
export function numberOutlineLines(lines: readonly { depth: number; text: string; memberId?: string }[]): NumberedLine[] {
  const counters: number[] = [];
  return lines.map((line) => {
    const d = line.depth;
    if (counters.length > d + 1) counters.length = d + 1; // returned to a shallower level → drop deeper counts
    while (counters.length < d + 1) counters.push(0); // descended → pad new levels
    counters[d] += 1;
    return { number: counters.slice(0, d + 1).join('.'), depth: d, text: line.text, ...(line.memberId !== undefined ? { memberId: line.memberId } : {}) };
  });
}

/** The board's connector tree as a numbered outline. Roots (indegree-0 cards) number 1, 2, 3…; their
 *  connector-children number 1.1, 1.2…. A connector-free board is a flat numbered list. */
export function numberedOutline(items: readonly BoardItem[]): NumberedLine[] {
  return numberOutlineLines(mindMapOutline(items, contentCardIds(items)));
}

/** True when the board has ≥1 content card to number — the gate for the outline surface. */
export function boardHasOutline(items: readonly BoardItem[]): boolean {
  return contentCardIds(items).length > 0;
}

/** The legal number of the row whose text matches `text` (first match), or null — for a cross-reference. */
export function outlineNumberOf(items: readonly BoardItem[], text: string): string | null {
  const needle = text.replace(/\s+/g, ' ').trim();
  return numberedOutline(items).find((l) => l.text === needle)?.number ?? null;
}

/** A human numbered-outline readout: each row indented by depth with its number, or an honest empty line. */
export function numberedOutlineText(items: readonly BoardItem[], title?: string): string {
  const rows = numberedOutline(items);
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`, '');
  lines.push('## Outline');
  if (rows.length === 0) {
    lines.push('- No cards');
    return lines.join('\n');
  }
  for (const r of rows) lines.push(`${'  '.repeat(r.depth)}${r.number} ${r.text}`);
  return lines.join('\n');
}
