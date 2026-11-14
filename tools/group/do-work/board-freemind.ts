// packages/group/do-work/board-freemind.ts
//
// BOARD ↔ FreeMind/Freeplane (.mm) (b173). FreeMind (and its successor Freeplane) is the most widely used
// open-source mind-mapping tool, and its `.mm` file is the de-facto mind-map interchange — distinct from OPML
// (an OUTLINER format) even though both are nested-element XML: `.mm` nests `<node TEXT="…">`. This gives the
// board a full round-trip with that whole ecosystem: export a board to `.mm`, edit it in FreeMind/Freeplane,
// paste it back.
//
// It adds ZERO parser or serializer code: FreeMind is just a `NestedTreeSpec` DATA row (`{tag:'node',
// textAttrs:['TEXT']}`) over the SAME generic `parseNestedTree` / `outlineToNestedXml` primitive OPML uses
// (b172/b173, L069/L090 — the two formats differ only in the element name + label attribute, which are DATA).
// The board builder is the SHARED `outlineLinesToBoardItems`. So this file is pure wiring: a sniff + the spec +
// the two thin round-trip functions. Pure, deterministic; the `.mm` `<map>` wrapper is ignored on import.

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { mindMapOutline, type OutlineLine } from './batch-actions';
import { parseNestedTree, outlineToNestedXml, type NestedTreeSpec } from 'trillion-workshop/tools/organize-the-sidebar/do-work/nested-tree-xml.ts';
import { outlineLinesToBoardItems } from './board-opml-import';

/** FreeMind's nested-tree dialect: `<node TEXT="…">`. One DATA row over the generic nested-XML primitive. */
export const FREEMIND_SPEC: NestedTreeSpec = { tag: 'node', textAttrs: ['TEXT'] };

/** True when the text is a FreeMind/Freeplane document (a `<map` root carrying at least one `<node TEXT=…>`).
 *  Conservative — requires BOTH so a bare `<map>` (or unrelated XML) never hijacks a plain paste. */
export function looksLikeFreemind(text: string): boolean {
  return typeof text === 'string' && /<map[\s>]/.test(text) && /<node\b[^>]*\bTEXT=/.test(text);
}

/** Parse a FreeMind `.mm` document into depth-tagged outline lines — one configuration of `parseNestedTree`. */
export function parseFreemind(text: string): OutlineLine[] {
  return parseNestedTree(text, FREEMIND_SPEC);
}

/** Build positioned board items from a FreeMind document — `parseFreemind` then the shared
 *  `outlineLinesToBoardItems`. A card per `<node>`, a connector per parent→child nesting. Empty → []. Pure. */
export function freemindToBoardItems(text: string, originX = 40, originY = 40): BoardItem[] {
  return outlineLinesToBoardItems(parseFreemind(text), originX, originY);
}

/**
 * Serialize the board's connector hierarchy as a FreeMind `.mm` document — the mind-map counterpart of the OPML
 * export, via the SAME `outlineToNestedXml` writer with the FreeMind spec. Composes `mindMapOutline` (the
 * connector-tree pre-order, L069/L093 — owns no tree logic); isolated cards become top-level `<node>`s; an empty
 * board yields a valid empty `<map>`. Deterministic; text XML-escaped by the shared serializer.
 */
export function boardToFreemind(items: readonly BoardItem[]): string {
  const cardIds = items.filter((i) => !itemIsConnector(i)).map((i) => i.memberId);
  const lines = mindMapOutline(items, cardIds);
  const body = lines.length > 0 ? `\n${outlineToNestedXml(lines, FREEMIND_SPEC, 1)}\n` : '';
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<map version="1.0.1">' + body + '</map>'].join('\n');
}
