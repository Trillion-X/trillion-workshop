// packages/group/show/spatial-cluster-facet.ts
//
// SPATIAL-CLUSTER FACET — the surface bridge that turns b109's DISCOVERED spatial grouping into a b107
// ClusterFacet, so the EXISTING `ClusterHullOverlay` outlines piles the user never tagged, with ZERO new
// render code (L030/L069 reuse). It runs DBSCAN (`spatialClusters`) over the board's item footprints once,
// builds a memberId → cluster-key map, and returns a `ClusterFacet` whose `keyOf` reads that map (noise → no
// key → no hull). Every downstream invariant of the hull overlay (blob geometry, tint, label, connector
// exclusion) is inherited unchanged — the only new thing is WHERE the grouping comes from (geometry, not a
// tag). This is the discovery-dual of the tag/kind/colour facets in `CLUSTER_FACETS`.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { itemIsConnector } from '../read-data/group-board-model.ts';
import {
  spatialClusters,
  clusterCount,
  type ClusterMetric,
  type ClusterRect,
} from '../do-work/spatial-clusters.ts';
import type { ClusterFacet } from './ClusterHullOverlay.tsx';

export interface SpatialClusterFacetOptions {
  readonly epsilon?: number;
  readonly minPoints?: number;
  readonly metric?: ClusterMetric;
  readonly rectOf?: (item: BoardItem) => ClusterRect;
  /** Human label for a discovered pile (default "Cluster N", 1-based). */
  readonly labelOf?: (clusterId: number) => string;
}

export interface SpatialClusterResult {
  readonly facet: ClusterFacet;
  /** How many piles were discovered (excludes noise). */
  readonly clusterCount: number;
  /** memberId → cluster key (only for clustered, non-noise items). */
  readonly keyByMember: ReadonlyMap<string, string>;
}

const defaultRect = (i: BoardItem): ClusterRect => ({ x: i.x, y: i.y, w: i.w, h: i.h });

/**
 * Run DBSCAN over the board's non-connector items and return a {@link ClusterFacet} for the hull overlay plus
 * the discovered count + memberId→key map. Items in noise carry no key (no hull). Deterministic.
 */
export function spatialClusterFacet(items: readonly BoardItem[], opts: SpatialClusterFacetOptions = {}): SpatialClusterResult {
  const rectOf = opts.rectOf ?? defaultRect;
  const labelOf = opts.labelOf ?? ((id: number) => `Cluster ${id + 1}`);
  // Cluster only the drawable (non-connector) items, preserving order for index-aligned labels.
  const drawable = items.filter((i) => !itemIsConnector(i));
  const labels = spatialClusters(drawable.map(rectOf), {
    epsilon: opts.epsilon,
    minPoints: opts.minPoints,
    metric: opts.metric,
  });
  const keyByMember = new Map<string, string>();
  const labelByKey = new Map<string, string>();
  drawable.forEach((item, i) => {
    const cid = labels[i];
    if (cid < 0) return; // noise → no cluster
    const key = `pile-${cid}`;
    keyByMember.set(item.memberId, key);
    if (!labelByKey.has(key)) labelByKey.set(key, labelOf(cid));
  });
  const facet: ClusterFacet = {
    id: 'spatial',
    label: 'Outline discovered piles',
    keyOf: (item) => keyByMember.get(item.memberId),
    labelOf: (key) => labelByKey.get(key) ?? key,
  };
  return { facet, clusterCount: clusterCount(labels), keyByMember };
}
