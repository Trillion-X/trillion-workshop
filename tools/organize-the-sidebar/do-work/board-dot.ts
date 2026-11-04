// packages/group/do-work/board-dot.ts
//
// Board ↔ DOT / Graphviz (b174). DOT is the most standard graph description language — Graphviz, and virtually
// every graph tool, reads and writes it. It is DISTINCT from Mermaid (a diagram-as-code for markdown) and
// GraphML (an XML analysis format): DOT is the plain-text `digraph { A -> B }` lingua franca. This gives the
// board a full round-trip with that whole ecosystem: export a board to `.dot`, run it through Graphviz / edit
// it, paste it back.
//
// The parser is genuinely new (DOT's `->`/`--` edge syntax + `id [label="…"]` decls differ from Mermaid's), but
// the board BUILDER is the SHARED `graphToBoardItems` (b174) that Mermaid + GraphML now use — DOT parses to the
// same `{nodes, edges}` and lays out via the one graph-layout body (L069/L093, zero builder duplication). Pure,
// deterministic; names no kind (L090). (Quoted ids that themselves contain an arrow operator are out of scope —
// the same pragmatic bound Mermaid's regex parser accepts.)

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { buildRelationGraph } from '../read-data/relationship-graph';
import { graphToBoardItems, type GraphNode, type GraphEdge } from './graph-to-board';

/** True when the text is a DOT/Graphviz document (a `graph`/`digraph` header with a `{`). Conservative. */
export function looksLikeDot(text: string): boolean {
  return typeof text === 'string' && /\b(?:di)?graph\b[^{]*\{/.test(text);
}

/** Strip a DOT id of its wrapping quotes + un-escape `\"`. */
function unquoteId(raw: string): string {
  const t = raw.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\"/g, '"') : t;
}

/** The `label` attribute value from a DOT `[…]` attribute list, or undefined. Handles a quoted or bare value. */
function attrLabel(attrs: string | undefined): string | undefined {
  if (!attrs) return undefined;
  const m = attrs.match(/\blabel\s*=\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)/);
  if (!m) return undefined;
  return m[1].startsWith('"') ? m[1].slice(1, -1).replace(/\\"/g, '"') : m[1];
}

const DOT_KEYWORD = /^(?:strict|digraph|graph|subgraph|node|edge)$/i;

/**
 * Parse a DOT document into `{nodes, edges}`. Recognizes edges (`A -> B`, `A -- B`, chained `A -> B -> C`,
 * `A -> B [label="…"]`) and node declarations (`A [label="…"]`); a node's label is its declared label else its
 * id; ids may be quoted. Header/keyword/brace lines are ignored. Comments (line, block, and hash) are stripped.
 * Deterministic (first-seen order). Unrecognized statements are skipped, never thrown.
 */
export function parseDot(text: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (typeof text !== 'string') return { nodes: [], edges: [] };
  const labelOf = new Map<string, string>();
  const order: string[] = [];
  const edges: GraphEdge[] = [];
  const see = (id: string) => {
    if (!labelOf.has(id)) {
      labelOf.set(id, id);
      order.push(id);
    }
  };
  const clean = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/^\s*#[^\n]*/gm, ' ');
  // statements separate on `;`, newline, AND braces (so single-line `digraph { A -> B }` splits the header off
  // the edge). A `{`/`}` inside a quoted label is out of scope (the same pragmatic bound as quoted arrows).
  for (const raw of clean.split(/[;\n{}]/)) {
    const stmt = raw.trim();
    if (!stmt) continue;
    if (/(->|--)/.test(stmt)) {
      const attrM = stmt.match(/\[([^\]]*)\]\s*$/);
      const relation = attrLabel(attrM?.[1]);
      const chain = attrM ? stmt.slice(0, attrM.index) : stmt;
      const parts = chain.split(/->|--/).map((p) => unquoteId(p)).filter((p) => p.length > 0 && !DOT_KEYWORD.test(p));
      for (let k = 0; k + 1 < parts.length; k += 1) {
        see(parts[k]);
        see(parts[k + 1]);
        edges.push({ from: parts[k], to: parts[k + 1], ...(relation ? { relation } : {}) });
      }
      continue;
    }
    const declM = stmt.match(/^("(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)\s*(?:\[([^\]]*)\])?/);
    if (!declM) continue;
    const id = unquoteId(declM[1]);
    if (DOT_KEYWORD.test(id)) continue; // the `digraph G {` header word, a global `node [..]`/`edge [..]`, etc.
    see(id);
    const lbl = attrLabel(declM[2]);
    if (lbl) labelOf.set(id, lbl);
  }
  return { nodes: order.map((id) => ({ id, label: labelOf.get(id) as string })), edges };
}

/** Build positioned board items from a DOT document — `parseDot` then the shared `graphToBoardItems`. A card
 *  per node, a connector per edge. Empty / node-less → []. Pure. */
export function dotToBoardItems(text: string, originX = 40, originY = 40): BoardItem[] {
  const { nodes, edges } = parseDot(text);
  return graphToBoardItems(nodes, edges, originX, originY);
}

/** A card's DOT label = its first non-empty line, `Untitled` when text-less. */
function label(item: BoardItem): string {
  const raw = typeof item.text === 'string' ? item.text : '';
  const first = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return first.length > 0 ? first : 'Untitled';
}

/** Escape a DOT quoted-string value (`"` and backslash). */
function dotEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Serialize the board's relationship graph as a DOT document — one `<id> [label="…"]` per content card + one
 * `<from> -> <to>` edge per connector (a non-default relation kind → an edge `[label="…"]`). Safe `n0,n1,…`
 * ids (a memberId is not a valid DOT id). `directed` (default true) picks `digraph`+`->` vs `graph`+`--`.
 * Composes the relationship-graph SSOT (dangling connectors dropped); deterministic; XML/quote-escaped.
 */
export function boardToDot(items: readonly BoardItem[], opts: { directed?: boolean } = {}): string {
  const directed = opts.directed !== false;
  const nodes = items.filter((i) => !itemIsConnector(i) && !i.isSection);
  const idOf = new Map<string, string>();
  nodes.forEach((n, i) => idOf.set(n.memberId, 'n' + i));
  const graph = buildRelationGraph(items);
  const op = directed ? '->' : '--';
  const lines: string[] = [`${directed ? 'digraph' : 'graph'} "Board" {`];
  for (const n of nodes) lines.push(`  ${idOf.get(n.memberId) as string} [label="${dotEscape(label(n))}"];`);
  for (const e of graph.edges) {
    const from = idOf.get(e.from);
    const to = idOf.get(e.to);
    if (!from || !to) continue; // an endpoint excluded from nodes (a section) — skip
    const rel = e.kind && e.kind !== 'relates-to' ? ` [label="${dotEscape(e.kind)}"]` : '';
    lines.push(`  ${from} ${op} ${to}${rel};`);
  }
  lines.push('}');
  return lines.join('\n');
}
