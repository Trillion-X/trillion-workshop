// packages/group/do-work/board-graphml.ts
//
// BOARD → GraphML (b149). Serialize the board's relationship graph as GraphML — the standard XML interchange
// that Gephi, Cytoscape, yEd, and networkx all import — so a user can take their knowledge board into a real
// graph-analysis tool. This is DISTINCT from the Mermaid export (`board-mermaid`): Mermaid is diagram-as-code
// for RENDERING a picture; GraphML is a DATA format for ANALYSIS, carrying typed node/edge attributes.
//
// The payoff is that this export is ENRICHED with the board's own computed analysis as node attributes — the
// PageRank `importance` (b147), the Louvain `community` index (b148), and the `degree` — so the graph lands in
// Gephi already scored and partitioned (colour by community, size by importance) with zero recomputation.
// It is the composition that makes those measures portable: one export row wiring three shipped primitives.
//
// Pure & deterministic: nodes are the non-connector, non-section cards in board order (stable `n0,n1,…` ids,
// since a memberId is not a valid XML id); edges come from the `relationship-graph` SSOT (dangling connectors
// already dropped); every label/attribute is XML-escaped so card text can never break the document. A DATA row
// in the `board-document-exports` registry — the blind export panel auto-surfaces it (L069/L090), zero panel
// change. Zero I/O.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { itemIsConnector } from '../read-data/group-board-model.ts';
import { buildRelationGraph } from '../read-data/relationship-graph.ts';
import { importanceRanks } from '../read-data/board-importance.ts';
import { detectCommunities } from '../read-data/board-communities.ts';

/** XML-escape the five predefined entities so card text / relation kinds can never break the document. */
function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A card's label = its first non-empty line (how mind-map cards are named), 'Untitled' when text-less. */
function label(item: BoardItem): string {
  const raw = typeof item.text === 'string' ? item.text : '';
  const first = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return first.length > 0 ? first : 'Untitled';
}

/**
 * Serialize the board to GraphML, each node enriched with `label`, `kind`, `importance` (PageRank),
 * `community` (Louvain, a 0-based index by sorted canonical id) and `degree`; each edge with its `relation`
 * kind. `directed` (default true) sets the graph's edgedefault. Deterministic.
 */
export function boardToGraphml(items: readonly BoardItem[], opts: { directed?: boolean } = {}): string {
  const directed = opts.directed !== false;
  const nodes = items.filter((i) => !itemIsConnector(i) && !i.isSection);
  const idOf = new Map<string, string>();
  nodes.forEach((n, i) => idOf.set(n.memberId, 'n' + i));

  const graph = buildRelationGraph(items);
  const importance = importanceRanks(items);
  const community = detectCommunities(items);
  // Map each community's canonical id → a compact 0-based integer index (sorted → deterministic).
  const communityIndex = new Map<string, number>();
  [...new Set(community.values())].sort().forEach((c, i) => communityIndex.set(c, i));
  const degreeOf = (id: string): number => (graph.out[id]?.length ?? 0) + (graph.inc[id]?.length ?? 0);

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="label" for="node" attr.name="label" attr.type="string"/>',
    '  <key id="kind" for="node" attr.name="kind" attr.type="string"/>',
    '  <key id="importance" for="node" attr.name="importance" attr.type="double"/>',
    '  <key id="community" for="node" attr.name="community" attr.type="int"/>',
    '  <key id="degree" for="node" attr.name="degree" attr.type="int"/>',
    '  <key id="relation" for="edge" attr.name="relation" attr.type="string"/>',
    `  <graph edgedefault="${directed ? 'directed' : 'undirected'}">`,
  ];
  for (const n of nodes) {
    const id = idOf.get(n.memberId) as string;
    lines.push(
      `    <node id="${id}">`,
      `      <data key="label">${xml(label(n))}</data>`,
      `      <data key="kind">${xml(typeof n.kind === 'string' ? n.kind : 'note')}</data>`,
      `      <data key="importance">${(importance.get(n.memberId) ?? 0).toFixed(6)}</data>`,
      `      <data key="community">${communityIndex.get(community.get(n.memberId) ?? '') ?? 0}</data>`,
      `      <data key="degree">${degreeOf(n.memberId)}</data>`,
      '    </node>',
    );
  }
  let e = 0;
  for (const edge of graph.edges) {
    const from = idOf.get(edge.from);
    const to = idOf.get(edge.to);
    if (!from || !to) continue; // an endpoint excluded from nodes (a section) — skip
    lines.push(
      `    <edge id="e${e++}" source="${from}" target="${to}">`,
      `      <data key="relation">${xml(edge.kind)}</data>`,
      '    </edge>',
    );
  }
  lines.push('  </graph>', '</graphml>');
  return lines.join('\n');
}
