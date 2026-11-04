// packages/group/do-work/board-hubs.ts
//
// BOARD HUBS — the connector-graph CENTRALITY primitive (b126). Critical-path finds the longest CHAIN; this
// finds the most CONNECTED cards — the hubs a mind-map or dependency board revolves around. It answers "what are
// the central ideas here?" by ranking cards by how many connectors touch them.
//
// Pure COMPOSITION of the existing `relationship-graph` leaf (`buildRelationGraph` already turns the board's
// connectors into an adjacency graph, dropping dangling edges) — this owns no graph construction. WHICH
// centrality (total degree / out-degree = influence / in-degree = authority) is DATA, not a branch:
// `CENTRALITY_MEASURES` is an injected-capability catalog (L069/L090) — a new measure is one row, zero engine
// code. Deterministic, zero I/O.

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { buildRelationGraph, type RelationGraph } from '../read-data/relationship-graph';

/** A card's connectivity in the connector graph. */
export interface HubNode {
  readonly memberId: string;
  readonly inDegree: number;
  readonly outDegree: number;
  readonly degree: number;
  /** The score under the chosen centrality measure (what the ranking sorts on). */
  readonly score: number;
}

/** A centrality measure: a pure (graph, memberId) → number. */
export interface CentralityMeasureDef {
  readonly id: string;
  readonly label: string;
  readonly scoreOf: (inDegree: number, outDegree: number) => number;
}

/**
 * The DATA catalog of centrality measures (L069/L090):
 * - `degree`: total connectors touching the card (in + out) — the overall hub.
 * - `influence`: out-degree — how many cards it points to (a source / driver).
 * - `authority`: in-degree — how many cards point to it (a sink / target).
 * A new measure is one row; nothing else changes.
 */
export const CENTRALITY_MEASURES: readonly CentralityMeasureDef[] = [
  { id: 'degree', label: 'Most connected', scoreOf: (i, o) => i + o },
  { id: 'influence', label: 'Points to most', scoreOf: (_i, o) => o },
  { id: 'authority', label: 'Pointed to most', scoreOf: (i) => i },
];

/** Look up a measure by id, falling back to the first (the maximally-capable default, L083). */
export function centralityById(id: string | undefined, measures: readonly CentralityMeasureDef[] = CENTRALITY_MEASURES): CentralityMeasureDef {
  return measures.find((m) => m.id === id) ?? measures[0];
}

/** Per-card in/out/total degree over the board's connector graph. Non-connector cards only. */
export function nodeDegrees(items: readonly BoardItem[], graph: RelationGraph = buildRelationGraph(items)): Map<string, { inDegree: number; outDegree: number; degree: number }> {
  const out = new Map<string, { inDegree: number; outDegree: number; degree: number }>();
  for (const it of items) {
    if (itemIsConnector(it)) continue;
    const inDegree = graph.inc[it.memberId]?.length ?? 0;
    const outDegree = graph.out[it.memberId]?.length ?? 0;
    out.set(it.memberId, { inDegree, outDegree, degree: inDegree + outDegree });
  }
  return out;
}

export interface HubOptions {
  readonly measure?: string;
  readonly measures?: readonly CentralityMeasureDef[];
  /** Drop cards whose score is below this (default 1 — a hub has at least one connection). */
  readonly minScore?: number;
  readonly limit?: number;
}

/**
 * Rank the board's cards by connector centrality, most-central first. Cards below `minScore` (default 1 — an
 * unconnected card is not a hub) are dropped. Deterministic: ties break by total degree (desc) then member id
 * (asc). Builds the relation graph once via the shared leaf (dangling connectors already excluded there).
 */
export function rankHubs(items: readonly BoardItem[], opts: HubOptions = {}): HubNode[] {
  const { measure, measures = CENTRALITY_MEASURES, minScore = 1, limit } = opts;
  const m = centralityById(measure, measures);
  const degrees = nodeDegrees(items);
  const nodes: HubNode[] = [];
  for (const [memberId, d] of degrees) {
    const score = m.scoreOf(d.inDegree, d.outDegree);
    if (score >= minScore) nodes.push({ memberId, inDegree: d.inDegree, outDegree: d.outDegree, degree: d.degree, score });
  }
  nodes.sort((a, b) => b.score - a.score || b.degree - a.degree || a.memberId.localeCompare(b.memberId));
  return typeof limit === 'number' ? nodes.slice(0, Math.max(0, limit)) : nodes;
}

/** Whether the board has any (non-dangling) connector at all — the gate for showing a hubs surface. */
export function boardHasConnectors(items: readonly BoardItem[]): boolean {
  return buildRelationGraph(items).edges.length > 0;
}
