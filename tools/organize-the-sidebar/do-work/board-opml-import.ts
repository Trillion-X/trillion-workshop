// packages/group/do-work/board-opml-import.ts
//
// OPML -> BOARD (b172). The round-trip partner of the OPML EXPORT (b155, `board-opml`). OPML is the standard
// outliner interchange — OmniOutliner, Workflowy, Dynalist, Bike, feed readers all speak it — and the board
// could WRITE it (mind-map connector hierarchy -> nested `<outline>`) but not READ it back. So you could send a
// board to Workflowy, restructure it there, but not bring the edited outline home. This closes that loop: paste
// an OPML document and get an editable mind-map — a card per `<outline>`, a parent->child connector per nesting.
//
// Mirrors the other importers (b135 mermaid, b171 graphml, b125 csv): a pure parser (`parseOpml` -> depth-tagged
// lines) + a board builder (`opmlToBoardItems` -> positioned cards + connectors) + a `looksLikeOpml` sniff for
// the paste router. The nesting is decoded DOM-free (a pure leaf runs in the wasm slot too): a tolerant regex
// tokenizer over `<outline>`/`</outline>` tracks a depth counter, so an `<outline>` with children opens a level
// and a self-closing `<outline/>` is a leaf. The parent->child links are the SHARED `outlineParents` linker the
// text-outline import already uses (L069/L093 — owns no tree logic), so OPML nesting and indented-text paste
// build the exact same mind-map. Un-escapes the five XML entities. Pure, deterministic; names no kind (L090).

import type { BoardItem } from '../read-data/group-board-model';
import { outlineParents, type OutlineLine } from './batch-actions';
import { parseNestedTree, type NestedTreeSpec } from './nested-tree-xml';

/** True when the text is an OPML document (carries an `<opml` root element). */
export function looksLikeOpml(text: string): boolean {
  return typeof text === 'string' && /<opml[\s>]/.test(text);
}

/** OPML's nested-tree dialect: `<outline text="…">` (falling back to `title`). One DATA row over the generic
 *  nested-XML parser/serializer — no hand-written tokenizer here (b173, L069/L100). Exported so the OPML EXPORT
 *  (`board-opml`) writes with the SAME spec it reads. */
export const OPML_SPEC: NestedTreeSpec = { tag: 'outline', textAttrs: ['text', 'title'] };

/**
 * Parse an OPML document into depth-tagged outline lines (the same `OutlineLine[]` the text-outline path uses) —
 * one configuration of the generic `parseNestedTree` primitive. The `<opml>/<head>/<title>/<body>` wrapper is
 * ignored (only `<outline>` matches). Tolerant + deterministic; never throws.
 */
export function parseOpml(text: string): OutlineLine[] {
  return parseNestedTree(text, OPML_SPEC);
}

const COL_GAP = 240;
const ROW_GAP = 96;

/**
 * Build positioned board items from ANY depth-tagged outline (the shared body of every nesting importer — OPML,
 * FreeMind, and the text-outline paste all reduce to `OutlineLine[]`): a note card per line (laid out left→right
 * by depth, stacked within a column) + a connector per parent→child nesting via the shared `outlineParents`
 * linker (L069/L100 — one builder, zero per-format duplication). Ids `n0,n1,…`; the live paste pipeline mints
 * fresh ones + re-anchors the connectors. Empty → []. Pure.
 */
export function outlineLinesToBoardItems(lines: readonly OutlineLine[], originX = 40, originY = 40): BoardItem[] {
  if (lines.length === 0) return [];
  const parents = outlineParents(lines);
  const rowOfCol = new Map<number, number>();
  const items: BoardItem[] = [];
  lines.forEach((line, i) => {
    const d = line.depth;
    const row = rowOfCol.get(d) ?? 0;
    rowOfCol.set(d, row + 1);
    items.push({
      memberId: 'n' + i,
      nodeRef: { id: 'n' + i } as never,
      kind: 'note',
      x: originX + d * COL_GAP,
      y: originY + row * ROW_GAP,
      w: 160,
      h: 60,
      isSection: false,
      childCount: 0,
      text: line.text,
      extra: {},
    } as BoardItem);
  });
  lines.forEach((_, i) => {
    if (parents[i] < 0) return;
    items.push({
      memberId: 'edge_' + i,
      nodeRef: { id: 'edge_' + i } as never,
      kind: 'note',
      x: 0,
      y: 0,
      w: 4,
      h: 4,
      isSection: false,
      childCount: 0,
      extra: { fromMemberId: 'n' + parents[i], toMemberId: 'n' + i },
    } as BoardItem);
  });
  return items;
}

/** Build positioned board items from an OPML document — `parseOpml` then the shared `outlineLinesToBoardItems`.
 *  A card per `<outline>`, a connector per parent→child nesting. Empty / outline-less → []. Pure. */
export function opmlToBoardItems(text: string, originX = 40, originY = 40): BoardItem[] {
  return outlineLinesToBoardItems(parseOpml(text), originX, originY);
}
