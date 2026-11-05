// packages/group/read-data/board-communities.ts
//
// GRAPH COMMUNITIES (label propagation) — the DENSE topic-clusters INSIDE a connected board. Distinct from
// the two shipped cluster notions: `board-components` finds hard ISLANDS (subgraphs with NO connector between
// them), and `spatial-cluster-facet` groups by screen POSITION. Communities are the soft groups a SINGLE
// connected graph splits into where links are DENSE within a group and SPARSE between groups — the "these
// cards are really about the same thing" topics, even though the whole board is one connected web. It is also
// distinct from `board-importance` (which RANKS cards) — this PARTITIONS them.
//
// Mechanism: greedy MODULARITY maximisation over the UNDIRECTED relationship graph — the local-moving phase
// of Louvain (a community is about link DENSITY, not direction). Every card starts in its own community; each
// sweep, in SORTED id order, a card moves to the neighbouring community that most raises modularity Q
// (ΔQ ∝ k_{i,in} − Σtot·k_i/2m: reward links INTO the community, penalise joining an already-heavy one), or
// stays if no move helps. This correctly SEPARATES two dense cliques joined by a single bridge (one shared
// link cannot beat the heavy-community penalty) — exactly what plain label-propagation fails at and what
// makes communities meaningfully different from `board-components`. Made fully DETERMINISTIC — Louvain's usual
// random node order + tie-break is replaced by sorted order + smallest-community ties + a fixed sweep cap — so
// the same board always yields the same partition (no `Math.random`, no wall-clock). A community's canonical
// id is its smallest member id; an isolated card (no connector) is its own singleton community.
//
// Pure COMPOSITION of the `relationship-graph` leaf (`buildRelationGraph`) — owns no graph construction
// (L069/L093). Connectors + sections are not clustered. Zero I/O.

import type { BoardItem } from './group-board-model.ts';
import { itemIsConnector } from './group-board-model.ts';
import { buildRelationGraph } from './relationship-graph.ts';

const MAX_SWEEPS = 30; // ample for board-sized graphs; the cap guarantees deterministic termination

/** Assign every content card (connectors + sections excluded) a community id (= the smallest member id of its
 *  community). Deterministic. Empty board → empty map; a card with no connectors → its own singleton. */
export function detectCommunities(items: readonly BoardItem[]): Map<string, string> {
  const nodes = items.filter((it) => !itemIsConnector(it) && !it.isSection).map((it) => it.memberId);
  const out = new Map<string, string>();
  if (nodes.length === 0) return out;

  const graph = buildRelationGraph(items);
  const nodeSet = new Set(nodes);
  // UNDIRECTED neighbour lists, de-duped (a pair wired twice is one adjacency; a self-loop is dropped).
  const nbr = new Map<string, string[]>(nodes.map((id) => [id, []]));
  const seenPair = new Set<string>();
  for (const e of graph.edges) {
    if (e.from === e.to || !nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    const key = e.from < e.to ? `${e.from}\u0000${e.to}` : `${e.to}\u0000${e.from}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    nbr.get(e.from)!.push(e.to);
    nbr.get(e.to)!.push(e.from);
  }

  const m = seenPair.size; // number of undirected edges
  const order = [...nodes].sort();
  const label = new Map<string, string>(nodes.map((id) => [id, id]));
  if (m === 0) {
    // No edges → every card is its own community; skip the modularity loop (2m = 0 would divide by zero).
    for (const id of nodes) out.set(id, id);
    return out;
  }
  const twoM = 2 * m;
  const degree = new Map<string, number>(nodes.map((id) => [id, nbr.get(id)!.length]));
  // Σtot[C] = total degree of the nodes currently in community C (starts = each node's own degree).
  const sigmaTot = new Map<string, number>(nodes.map((id) => [id, degree.get(id)!]));
  const EPS = 1e-12;

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep += 1) {
    let changed = false;
    for (const id of order) {
      const ns = nbr.get(id)!;
      if (ns.length === 0) continue; // isolated card stays its own community
      const ci = label.get(id)!;
      const ki = degree.get(id)!;
      // Detach i from its community before scoring (so its own degree does not penalise staying).
      sigmaTot.set(ci, sigmaTot.get(ci)! - ki);
      // k_{i,in}: edges from i into each neighbouring community (i already detached).
      const linksTo = new Map<string, number>();
      for (const nb of ns) {
        const c = label.get(nb)!;
        linksTo.set(c, (linksTo.get(c) ?? 0) + 1);
      }
      // ΔQ (up to the common /m factor) of placing i into C = linksTo(C) − Σtot[C]·k_i/2m. Start with ci.
      const gainOf = (c: string): number => (linksTo.get(c) ?? 0) - (sigmaTot.get(c)! * ki) / twoM;
      let bestC = ci;
      let bestGain = gainOf(ci);
      for (const c of linksTo.keys()) {
        const g = gainOf(c);
        if (g > bestGain + EPS || (Math.abs(g - bestGain) <= EPS && c < bestC)) {
          bestC = c;
          bestGain = g;
        }
      }
      label.set(id, bestC);
      sigmaTot.set(bestC, sigmaTot.get(bestC)! + ki);
      if (bestC !== ci) changed = true;
    }
    if (!changed) break;
  }

  // Canonicalise: nodes sharing a final community label form a community; its id is the smallest member id.
  const byLabel = new Map<string, string[]>();
  for (const id of nodes) {
    const l = label.get(id)!;
    const g = byLabel.get(l);
    if (g) g.push(id);
    else byLabel.set(l, [id]);
  }
  for (const members of byLabel.values()) {
    members.sort();
    const canon = members[0];
    for (const m of members) out.set(m, canon);
  }
  return out;
}

/** The communities as sorted member-id groups, ordered largest-first (id tie-break) — for a readout / proof. */
export function communityGroups(items: readonly BoardItem[]): string[][] {
  const comm = detectCommunities(items);
  const byId = new Map<string, string[]>();
  for (const [member, cid] of comm) {
    const g = byId.get(cid);
    if (g) g.push(member);
    else byId.set(cid, [member]);
  }
  return [...byId.values()]
    .map((g) => g.sort())
    .sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
}

/** How many communities the board splits into (singletons counted). */
export function communityCount(items: readonly BoardItem[]): number {
  return communityGroups(items).length;
}

/**
 * A facet-ready view for the "Group by cluster" arrange surface: a per-card `keyOf` (a card in a SINGLETON
 * community returns '' → the Unclustered pile, so the facet isn't flooded with one-card groups) plus a
 * numbered `labelMap` ("Cluster 1", "Cluster 2", … by sorted canonical id). Deterministic.
 */
export function numberedCommunities(items: readonly BoardItem[]): {
  keyOf: (item: BoardItem) => string;
  labelMap: Record<string, string>;
} {
  const comm = detectCommunities(items);
  const sizes = new Map<string, number>();
  for (const c of comm.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  const multi = [...new Set([...comm.values()].filter((c) => (sizes.get(c) ?? 0) >= 2))].sort();
  const labelMap: Record<string, string> = {};
  multi.forEach((c, i) => {
    labelMap[c] = `Cluster ${i + 1}`;
  });
  const keyOf = (item: BoardItem): string => {
    const c = comm.get(item.memberId);
    return c && (sizes.get(c) ?? 0) >= 2 ? c : '';
  };
  return { keyOf, labelMap };
}
