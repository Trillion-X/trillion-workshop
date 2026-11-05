// packages/group/do-work/board-opml.ts
//
// BOARD → OPML. OPML (Outline Processor Markup Language) is the STANDARD interchange for outliners — import it
// into OmniOutliner, Workflowy, Dynalist, Bike, a feed reader, or any tool that speaks the format, and your
// mind-map arrives as a real nested outline. This serializes the board's CONNECTOR hierarchy (root card →
// its children via out-edges, depth-first in visual order) as nested `<outline>` elements. DISTINCT from the
// `markdown` export (a flat bullet list for a human to read) and `graphml` (the graph for network analysis):
// OPML is the NESTED tree for an outliner to re-open and edit.
//
// SSOT: the hierarchy is NOT re-derived here — it composes `mindMapOutline` (the connector-tree pre-order the
// "copy as outline" action already uses, L069/L093 — owns no tree logic), whose depth-tagged lines map 1:1
// onto OPML nesting. Pure, deterministic; XML-escaped so a card's text can never break the document.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { itemIsConnector } from '../read-data/group-board-model.ts';
import { mindMapOutline } from './batch-actions.ts';
import { escapeXml, outlineToNestedXml } from './nested-tree-xml.ts';
import { OPML_SPEC } from './board-opml-import.ts';

/** Serialize the whole board's connector hierarchy as an OPML 2.0 document. `title` names the `<head><title>`
 *  (default "Board"). Isolated cards (no connectors) each appear as a top-level `<outline>`. An empty board
 *  yields a valid document with an empty `<body>`. Deterministic (visual order via `mindMapOutline`). */
export function boardToOpml(items: readonly BoardItem[], title?: string): string {
  const cardIds = items.filter((i) => !itemIsConnector(i)).map((i) => i.memberId);
  const lines = mindMapOutline(items, cardIds);
  const docTitle = title && title.trim() !== '' ? title.trim() : 'Board';
  const body = lines.length > 0 ? `\n${outlineToNestedXml(lines, OPML_SPEC, 2)}\n  ` : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeXml(docTitle)}</title>`,
    '  </head>',
    `  <body>${body}</body>`,
    '</opml>',
  ].join('\n');
}
