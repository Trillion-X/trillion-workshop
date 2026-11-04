// packages/group/read-data/board-cluster-facet.ts
//
// CLUSTER FACET — the adapter that makes the connector graph a REDUCTION DIMENSION. The reducer family
// (census/pivot/histogram/crosstab) groups cards by a `FacetExtract` — a tag, a colour, a bucketed measure.
// This adds a new KIND of extractor: a card's connected-COMPONENT ("Cluster 1", "Cluster 2", … the separate
// pieces `board-islands` finds). Feed it to `facetCensus` → cards-per-cluster; to `facetPivot` → avg progress
// per cluster; to `crossTab` → cluster × tag — ZERO new reducer (L069). It is the graph-side twin of
// `bucketFacet` (b176 made a continuous measure a dimension; this makes graph topology a dimension).
//
// A "cluster" is a connected component of ≥ `minSize` cards (default 2 — a lone card is an orphan, not a
// cluster; it maps to no label → joins no group). Labels default to "Cluster N" by island rank (largest
// first, deterministic), overridable via `labelOf`. The id→label map is precomputed ONCE, so the returned
// extractor is O(1) per card. A pure composition over `boardIslands` (owns no component/edge logic, L093).

import type { BoardItem } from './group-board-model';
import type { FacetExtract } from './board-facet-census';
import { boardIslands, type Island } from './board-islands';

/** Options for {@link clusterFacet}. */
export interface ClusterFacetOptions {
  /** The smallest component counted as a cluster (default 2 — a lone card is an orphan, mapped to no label). */
  readonly minSize?: number;
  /** Label for the island at `rank` (0 = largest). Default `"Cluster {rank+1}"`. */
  readonly labelOf?: (rank: number, island: Island) => string;
}

/**
 * A `FacetExtract` that tags each card with its connected-component label — the graph-topology dimension for
 * the reducer family. Cards in a component smaller than `minSize` (default 2), on no component, or connectors
 * emit `[]` (they join no cluster group). The id→label map is built ONCE from `boardIslands`; the returned
 * function is a pure O(1) lookup. Deterministic (island rank order). Owns no component logic.
 */
export function clusterFacet(items: readonly BoardItem[], opts: ClusterFacetOptions = {}): FacetExtract {
  const minSize = opts.minSize ?? 2;
  const label = opts.labelOf ?? ((rank: number) => `Cluster ${rank + 1}`);
  const byId = new Map<string, string>();
  boardIslands(items).forEach((island, rank) => {
    if (island.size < minSize) return;
    const l = label(rank, island);
    for (const id of island.memberIds) byId.set(id, l);
  });
  return (item: BoardItem): readonly string[] => {
    const l = byId.get(item.memberId);
    return l ? [l] : [];
  };
}
