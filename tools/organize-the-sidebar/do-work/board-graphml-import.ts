// packages/group/do-work/board-graphml-import.ts
//
// GraphML -> BOARD (b171). The round-trip partner of the GraphML EXPORT (b149, `board-graphml`). GraphML is the
// standard XML interchange Gephi / Cytoscape / yEd / networkx all speak, and the board could already WRITE it
// but not READ it back — you could send a board to Gephi, score/partition it there, but not bring the edited
// graph home. This closes that loop: paste a GraphML document (from a tool or an earlier export) and get an
// editable board — a card per `<node>`, a connector per `<edge>`.
//
// Mirrors the other importers exactly (b135 mermaid, b125 csv, the outline import): a pure parser
// (`parseGraphml` -> nodes + edges) + a board builder (`graphmlToBoardItems` -> positioned node cards +
// connector items) + a `looksLikeGraphml` sniff for the paste router. The live paste feeds the items through the
// SAME proven clone pipeline (copyItemsToClipboard -> clipboardToDrafts -> placePasteDrafts) that mints fresh ids
// and re-anchors connectors — zero new placement/re-anchor logic (L030/L069). It is DOM-free (a pure leaf runs
// in the wasm slot too): a tolerant regex parse of GraphML's simple node/edge/data structure, robust to
// attribute order + self-closing tags, un-escaping the five XML entities the export writes. Pure, deterministic;
// names no kind (L090).

import type { BoardItem } from '../read-data/group-board-model';
import { graphToBoardItems } from './graph-to-board';

export interface GraphmlNode {
  readonly id: string;
  readonly label: string;
  readonly kind?: string;
}
export interface GraphmlEdge {
  readonly from: string;
  readonly to: string;
  readonly relation?: string;
}
export interface ParsedGraphml {
  readonly nodes: readonly GraphmlNode[];
  readonly edges: readonly GraphmlEdge[];
}

/** True when the text is a GraphML document (carries a `<graphml` root element). */
export function looksLikeGraphml(text: string): boolean {
  return typeof text === 'string' && /<graphml[\s>]/.test(text);
}

/** Reverse of the export's XML escaping — un-escape the five predefined entities. `&amp;` LAST so an escaped
 *  `&amp;lt;` (a literal `&lt;` in the source) does not get double-decoded. */
function unxml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Read an attribute value off an element's open-tag attribute string (`id="n0" source="n1"`). */
function attr(tagAttrs: string, name: string): string | undefined {
  const m = tagAttrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? unxml(m[1]) : undefined;
}

/** Read a `<data key="KEY">VALUE</data>` value from an element's inner XML, or undefined. */
function dataValue(inner: string, key: string): string | undefined {
  const m = inner.match(new RegExp(`<data\\s+key="${key}"\\s*>([\\s\\S]*?)</data>`));
  return m ? unxml(m[1].trim()) : undefined;
}

const NODE_RE = /<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g;
const EDGE_RE = /<edge\b([^>]*?)(?:\/>|>([\s\S]*?)<\/edge>)/g;

/**
 * Parse a GraphML document into nodes + edges. A node's label is its `<data key="label">` (else its id);
 * an edge carries its `source`/`target` and optional `<data key="relation">`. Attribute order + self-closing
 * `<node/>`/`<edge/>` are tolerated; a node/edge missing its id/endpoints is skipped, never thrown. Deterministic
 * (document order). Names no kind — a `kind` data value is carried through verbatim when present (L090).
 */
export function parseGraphml(text: string): ParsedGraphml {
  const nodes: GraphmlNode[] = [];
  const edges: GraphmlEdge[] = [];
  if (typeof text !== 'string') return { nodes, edges };

  for (let m = NODE_RE.exec(text); m !== null; m = NODE_RE.exec(text)) {
    const id = attr(m[1], 'id');
    if (!id) continue;
    const inner = m[2] ?? '';
    nodes.push({ id, label: dataValue(inner, 'label') ?? id, ...(dataValue(inner, 'kind') ? { kind: dataValue(inner, 'kind') } : {}) });
  }
  for (let m = EDGE_RE.exec(text); m !== null; m = EDGE_RE.exec(text)) {
    const from = attr(m[1], 'source');
    const to = attr(m[1], 'target');
    if (!from || !to) continue;
    const relation = dataValue(m[2] ?? '', 'relation');
    edges.push({ from, to, ...(relation ? { relation } : {}) });
  }
  return { nodes, edges };
}

/**
 * Build positioned board items from a GraphML document — `parseGraphml` then the SHARED `graphToBoardItems`
 * builder (b174, the one graph-layout body Mermaid/GraphML/DOT share). GraphML nodes carry an extra `kind`
 * (ignored by the layout); the edge `relation` is the connector's relation. Empty / node-less → []. Pure.
 */
export function graphmlToBoardItems(text: string, originX = 40, originY = 40): BoardItem[] {
  const { nodes, edges } = parseGraphml(text);
  return graphToBoardItems(
    nodes.map((n) => ({ id: n.id, label: n.label })),
    edges,
    originX,
    originY,
  );
}
