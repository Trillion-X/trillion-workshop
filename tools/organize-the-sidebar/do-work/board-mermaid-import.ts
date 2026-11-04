// packages/group/do-work/board-mermaid-import.ts
//
// MERMAID -> BOARD (b135). The round-trip partner of the Mermaid EXPORT (b134): paste a Mermaid flowchart and
// get an editable board -- a card per node, a connector per edge, laid out left-to-right by dependency depth.
// So a diagram-as-code you have in a README / GitHub / doc becomes a real board you can rearrange, restyle, and
// extend. The inverse of b134, exactly as split (b133) is the inverse of merge (b132).
//
// A pure parser (`parseMermaid` -> nodes + edges) + a board builder (`mermaidToBoardItems` -> positioned node
// cards + connector items). The live import (in the paste handler) feeds those items through the SAME proven
// clone pipeline capsule-import uses (copyItemsToClipboard -> clipboardToDrafts -> placePasteDrafts), which
// mints fresh ids and re-anchors the connectors -- zero new placement/re-anchor logic (L030/L069). Pure,
// deterministic; names no kind (L090).

import type { BoardItem } from '../read-data/group-board-model';
import { graphToBoardItems } from './graph-to-board';

export interface MermaidNode {
  readonly id: string;
  readonly label: string;
}
export interface MermaidEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
}
export interface ParsedMermaid {
  readonly nodes: readonly MermaidNode[];
  readonly edges: readonly MermaidEdge[];
}

/** True when the text is a Mermaid flowchart (starts with a `flowchart`/`graph` header). */
export function looksLikeMermaid(text: string): boolean {
  return typeof text === 'string' && /^\s*(?:flowchart|graph)\b/.test(text);
}

/** Strip a node label's wrapping quotes + un-escape the export's entities. */
function cleanLabel(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/#quot;/g, '"')
    .trim();
}

/** Parse one node token ("n0", `n0["Label"]`, `n0(Label)`, `n0{Label}`, `n0((Label))`) → id + optional label. */
function parseToken(tok: string): { id: string; label?: string } | null {
  const m = tok
    .trim()
    .match(/^([A-Za-z0-9_][\w-]*)\s*(?:\[\[([^\]]*)\]\]|\[([^\]]*)\]|\(\(([^)]*)\)\)|\(([^)]*)\)|\{([^}]*)\})?\s*$/);
  if (!m) return null;
  const label = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
  return { id: m[1], label: label != null ? cleanLabel(label) : undefined };
}

// An edge operator: any dash/dot/equals run ending in '>' (arrow) or a bare dash run (open link),
// optionally followed by a |label|. `-->`, `---`, `-.->`, `==>`, `-->|kind|`.
const EDGE_RE = /^(.*?)\s*(?:-{2,3}>|={2,3}>|-\.->|-{2,3})\s*(?:\|([^|]*)\|\s*)?(.*)$/;

/**
 * Parse a Mermaid flowchart into nodes + edges. Recognizes node declarations and edges (`A --> B`,
 * `A -->|kind| B`, and inline-declared endpoints `A[Start] --> B[End]`). Header/comment/subgraph lines are
 * ignored. A node's label is its most specific declaration (a labelled mention wins over a bare id). Deterministic
 * (nodes in first-seen order). Unrecognized lines are skipped, never thrown.
 */
export function parseMermaid(text: string): ParsedMermaid {
  const labels = new Map<string, string | undefined>(); // id -> best label (first-seen order preserved by Map)
  const edges: MermaidEdge[] = [];
  const note = (t: { id: string; label?: string } | null): void => {
    if (!t) return;
    const prev = labels.get(t.id);
    // keep the first non-empty label; register the id even when bare
    if (!labels.has(t.id)) labels.set(t.id, t.label);
    else if (prev == null && t.label != null) labels.set(t.id, t.label);
  };

  for (const rawLine of (typeof text === 'string' ? text : '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (/^(?:flowchart|graph)\b/.test(line)) continue; // header
    if (line.startsWith('%%')) continue; // comment
    if (/^(?:subgraph|end)\b/.test(line)) continue; // grouping (flattened for v1)

    const m = line.match(EDGE_RE);
    if (m && m[1].trim() !== '' && m[3].trim() !== '') {
      const left = parseToken(m[1]);
      const right = parseToken(m[3]);
      if (left && right) {
        note(left);
        note(right);
        const label = (m[2] ?? '').trim();
        edges.push({ from: left.id, to: right.id, ...(label ? { label } : {}) });
        continue;
      }
    }
    // a plain node declaration line
    note(parseToken(line));
  }

  const nodes: MermaidNode[] = [...labels.entries()].map(([id, label]) => ({ id, label: label && label.length > 0 ? label : id }));
  return { nodes, edges };
}

/**
 * Build a board (positioned node cards + connector items) from a Mermaid flowchart — `parseMermaid` then the
 * SHARED `graphToBoardItems` builder (b174, the one graph-layout body Mermaid/GraphML/DOT share). The mermaid
 * edge LABEL is the connector's relation. Pure & deterministic. Empty when nothing parses.
 */
export function mermaidToBoardItems(text: string, originX = 40, originY = 40): BoardItem[] {
  const { nodes, edges } = parseMermaid(text);
  return graphToBoardItems(
    nodes,
    edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { relation: e.label } : {}) })),
    originX,
    originY,
  );
}
