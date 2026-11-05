// packages/group/do-work/board-mermaid.ts
//
// BOARD -> MERMAID (b134). Serialize the board's cards + connectors as a Mermaid flowchart -- diagram-as-code
// you can paste into a doc, a README, GitHub, Notion, or any Mermaid renderer. A dependency/mind-map board
// becomes a portable `flowchart TD` (or LR) with a node per card and an edge per connector (labelled by its
// relationship kind). This is a new row in the DATA-driven document-export registry (`board-document-exports`)
// -- the export panel is blind and auto-surfaces it (L069/L090), zero panel change.
//
// Pure & deterministic: edges come from the `relationship-graph` SSOT (which already drops dangling connectors),
// each card gets a stable safe id (mermaid ids must be alphanumeric, but a memberId can be anything), and labels
// are escaped so a card's text can't break the diagram syntax. Zero I/O.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { itemIsConnector } from '../read-data/group-board-model.ts';
import { buildRelationGraph, DEFAULT_RELATION_KIND } from '../read-data/relationship-graph.ts';

export interface MermaidOptions {
  /** Flow direction: 'TD' top-down (default) or 'LR' left-right. */
  readonly direction?: 'TD' | 'LR';
}

/** A card's node label: its first non-empty line, escaped so quotes/newlines/pipes can't break the syntax. */
function nodeLabel(item: BoardItem): string {
  const raw = typeof item.text === 'string' ? item.text : '';
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const text = firstLine.length > 0 ? firstLine : 'Untitled';
  return text
    .replace(/"/g, '#quot;') // mermaid entity — renders as a real quote, never closes the label
    .replace(/[|]/g, '/') // a pipe would terminate an edge label / confuse the parser
    .slice(0, 80);
}

/** An edge label from a connector's relationship kind (the default/unnamed kind → no label). */
function edgeLabel(kind: string): string {
  if (!kind || kind === DEFAULT_RELATION_KIND) return '';
  return kind.replace(/["|\r\n]/g, ' ').trim().slice(0, 40);
}

/**
 * Serialize the board to a Mermaid flowchart. One node per non-connector, non-section card (isolated cards
 * included — a lone node is valid); one edge per connector (from the relationship graph, so dangling connectors
 * are dropped), labelled by its relationship kind when it is not the default. Deterministic.
 */
export function boardToMermaid(items: readonly BoardItem[], opts: MermaidOptions = {}): string {
  const dir = opts.direction === 'LR' ? 'LR' : 'TD';
  const nodes = items.filter((i) => !itemIsConnector(i) && !i.isSection);

  // Safe mermaid id per card, assigned in BOARD order so the node lines read n0, n1, n2 top-to-bottom the
  // way the board does (a memberId can be anything; a mermaid id must be alphanumeric). Deterministic per board.
  const idOf = new Map<string, string>();
  nodes.forEach((n, i) => idOf.set(n.memberId, 'n' + i));

  const lines: string[] = ['flowchart ' + dir];
  for (const n of nodes) {
    lines.push('    ' + (idOf.get(n.memberId) as string) + '["' + nodeLabel(n) + '"]');
  }

  const graph = buildRelationGraph(items);
  for (const e of graph.edges) {
    const from = idOf.get(e.from);
    const to = idOf.get(e.to);
    if (!from || !to) continue; // an endpoint that is a section (excluded from nodes) — skip
    const label = edgeLabel(e.kind);
    lines.push('    ' + from + (label ? ' -->|' + label + '| ' : ' --> ') + to);
  }

  return lines.join('\n');
}
