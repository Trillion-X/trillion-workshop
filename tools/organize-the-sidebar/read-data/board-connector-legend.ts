// packages/group/read-data/board-connector-legend.ts
//
// CONNECTOR LEGEND — the key for a board's diagram: which RELATIONSHIP TYPES its connectors use and how many of
// each. Every node-topology reader (hubs, components, sources-sinks, critical-path) analyzes the SHAPE of the
// graph; this catalogs its EDGE VOCABULARY — "this board has 6 'blocks' arrows, 3 'relates-to', 1 'duplicates'".
// The legend a reader needs to make sense of a dense diagram, and the handle to act on one relationship type.
//
// A pure composition of the relationship-graph SSOT (`buildRelationGraph` — reads each connector's
// self-describing `extra.relationKind` and, crucially, DROPS dangling connectors so the legend never counts a
// phantom edge). This leaf owns no graph construction (L069/L093). Document-style counts: one per real edge.
// Pure, deterministic (tally, tie-break by kind).

import type { BoardItem } from './group-board-model';
import { buildRelationGraph, type RelationGraph } from './relationship-graph';

/** One relationship type in play + how many connectors carry it. */
export interface LegendEntry {
  readonly kind: string;
  readonly count: number;
}

export interface LegendOptions {
  /** Cap the returned entries (most-used first). Default: all. */
  readonly limit?: number;
}

/** Tally the graph's edges by relation kind, ranked count desc then kind asc. */
function legendFromGraph(graph: RelationGraph, opts: LegendOptions = {}): LegendEntry[] {
  const byKind = new Map<string, number>();
  for (const e of graph.edges) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  const out: LegendEntry[] = [];
  for (const [kind, count] of byKind) out.push({ kind, count });
  out.sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return opts.limit != null ? out.slice(0, opts.limit) : out;
}

/** The board's relationship legend: each connector kind with its real (non-dangling) edge count. */
export function connectorLegend(items: readonly BoardItem[], opts: LegendOptions = {}): LegendEntry[] {
  return legendFromGraph(buildRelationGraph(items), opts);
}

/** The most-used relationship kind (most connectors, tie → alpha), or null when the board has no connectors. */
export function topRelationKind(items: readonly BoardItem[]): string | null {
  return connectorLegend(items)[0]?.kind ?? null;
}

/** The distinct cards touched by the top relationship's connectors (either endpoint, sorted) — what
 *  "Select cards in the main relationship" selects. */
export function cardIdsInTopRelationship(items: readonly BoardItem[]): string[] {
  const graph = buildRelationGraph(items);
  const top = legendFromGraph(graph)[0]?.kind;
  if (top === undefined) return [];
  const ids = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== top) continue;
    ids.add(e.from);
    ids.add(e.to);
  }
  return [...ids].sort();
}

/** True when the board has ≥1 real connector — the gate for the legend surface. */
export function boardHasRelationships(items: readonly BoardItem[]): boolean {
  return buildRelationGraph(items).edges.length > 0;
}

/** A human "## Relationship legend" readout: each kind with its connector count, or an honest empty line. */
export function connectorLegendText(items: readonly BoardItem[], title?: string, opts: LegendOptions = {}): string {
  const legend = connectorLegend(items, opts);
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`, '');
  lines.push('## Relationship legend');
  if (legend.length === 0) {
    lines.push('- No connectors');
    return lines.join('\n');
  }
  for (const e of legend) lines.push(`- ${e.kind} — ${e.count} connector${e.count === 1 ? '' : 's'}`);
  return lines.join('\n');
}
