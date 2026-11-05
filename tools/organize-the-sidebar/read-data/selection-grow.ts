// packages/group/read-data/selection-grow.ts
//
// GROW / SHRINK a selection over the relation graph — the third way to select cards, the graph-connectivity
// sibling of `itemsInRect` (b184, select by GEOMETRY — a rectangle) and `reportSelect` (b180, select by
// ANALYSIS — a report predicate). A canvas+graph tool's canonical "grow selection" / "select connected" /
// ego-network-radius op: marquee a few cards, then pull in everything within N relationship hops.
//
// The engine is ONE bounded, multi-seed, undirected BFS (`growSelection`, dilate by `hops`). Everything else is
// a configuration of it: `hops=0` is identity, `hops=Infinity` is the relation-connected COMPONENT of the seeds
// (distinct from `islandOf`'s SPATIAL-proximity component), the shell at exactly `hops` is the ripple FRONTIER,
// and erosion (`shrinkSelection`) is the set-inverse (drop the boundary, keep the interior). A relation `kind`
// may scope the walk. Pure, deterministic, cycle-safe; consumes the RelationGraph, owns no board vocabulary.

import type { RelationGraph } from './relationship-graph.ts';
import { neighbors, relationsFrom, relationsTo } from './relationship-graph.ts';

/** The undirected 1-hop neighbours of `id`, restricted to one relation `kind` when given. Reuses the graph's
 *  own `neighbors` for the all-kinds case (SSOT); filters both directions when a kind is named. */
function neighborsOf(graph: RelationGraph, id: string, kind?: string): string[] {
  if (kind === undefined) return neighbors(graph, id);
  const set = new Set<string>();
  for (const e of relationsFrom(graph, id, kind)) set.add(e.to);
  for (const e of relationsTo(graph, id, kind)) set.add(e.from);
  return [...set].sort();
}

/**
 * DILATE a selection: the seed ids plus every id within `hops` relationship edges of ANY seed (undirected BFS
 * from all seeds at once). `hops=0` returns the seeds unchanged; `hops=Infinity` returns the whole relation-
 * connected component(s) the seeds sit in. Isolated seeds (no edges) stay selected — growth only ADDS. A `kind`
 * argument scopes expansion to one relationship kind. Deterministic order: seeds first (input order, deduped),
 * then newly-reached ids in BFS-discovery order. Cycle-safe (a `seen` set bounds the walk). Pure.
 */
export function growSelection(graph: RelationGraph, seedIds: readonly string[], hops = 1, kind?: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  let frontier: string[] = [];
  for (const id of seedIds) {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
      frontier.push(id);
    }
  }
  const rounds = Number.isFinite(hops) ? Math.max(0, Math.floor(hops)) : Infinity;
  let r = 0;
  while (r < rounds && frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of neighborsOf(graph, id, kind)) {
        if (!seen.has(nb)) {
          seen.add(nb);
          order.push(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
    r++;
  }
  return order;
}

/** The relation-connected component(s) containing the seeds — `growSelection` with unbounded hops. The GRAPH
 *  analogue of `islandOf` (which clusters by spatial proximity): "select everything linked to this, however far". */
export function relationComponentOf(graph: RelationGraph, seedIds: readonly string[], kind?: string): string[] {
  return growSelection(graph, seedIds, Infinity, kind);
}

/** The RIPPLE shell at EXACTLY `hops` — the ids newly reached at that distance and no closer (grow(hops) minus
 *  grow(hops-1)). `hops=0` is the seeds themselves; `hops=1` is the immediate neighbours not already seeds.
 *  Deterministic (discovery order). Drives ripple highlights / "expand one ring" / concentric layout. */
export function selectionFrontier(graph: RelationGraph, seedIds: readonly string[], hops: number, kind?: string): string[] {
  const n = Number.isFinite(hops) ? Math.max(0, Math.floor(hops)) : 0;
  const inner = n === 0 ? new Set<string>() : new Set(growSelection(graph, seedIds, n - 1, kind));
  return growSelection(graph, seedIds, n, kind).filter((id) => !inner.has(id));
}

/** ERODE a selection: keep only INTERIOR ids — those all of whose neighbours are ALSO selected — dropping the
 *  boundary (ids touching a card outside the set). The set-inverse of `growSelection` (dilate). A seed with no
 *  neighbours is interior (trivially all-inside). Deterministic (input order). A `kind` argument scopes the
 *  neighbour test. Pure. */
export function shrinkSelection(graph: RelationGraph, selectedIds: readonly string[], kind?: string): string[] {
  const inSel = new Set(selectedIds);
  return selectedIds.filter((id, i) => selectedIds.indexOf(id) === i && neighborsOf(graph, id, kind).every((nb) => inSel.has(nb)));
}
