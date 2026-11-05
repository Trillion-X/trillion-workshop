// packages/group/do-work/spatial-clusters.ts
//
// SPATIAL CLUSTERS — the generative primitive behind "find the PILES on the board" (the tldraw/Miro
// auto-organize canon: discover groups of items that sit near each other, WITHOUT the user tagging them).
// It is the DISCOVERY dual of `cluster-hull` (b107): the hull outlines a grouping you already HAVE (a tag/
// kind facet), this INFERS the grouping from geometry alone. The requests "auto-group nearby notes / select
// this pile / count the clusters / outline the discovered regions" are all ONE unsupervised computation
// configured by HOW CLOSE counts as "together" (`epsilon`), HOW MANY makes a real pile (`minPoints`), and
// WHICH distance (`metric` — edge gap vs centre distance, injected). The algorithm is DBSCAN: density-based,
// finds arbitrarily-shaped clusters, and labels sparse outliers as noise (−1) rather than forcing them into a
// group (unlike k-means, it needs no cluster count and no round blobs).
//
// Pure leaf — only local rect types + the `finiteCoord` clamp SSOT. Deterministic (input-order iteration +
// FIFO expansion → identical labels every run), zero I/O, framework-agnostic. Composes with `cluster-hull`:
// feed each discovered cluster's rects to `convexHull`/`hullPath` and the board outlines piles it was never
// told about.

import { finiteCoord } from '../read-data/finite-coord.ts';

export interface ClusterRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A distance between two footprints (0 = touching/overlapping). Injected so "near" can mean edge-gap or
 *  centre-distance without the algorithm caring. */
export type ClusterMetric = (a: ClusterRect, b: ClusterRect) => number;

const fx = (v: number) => finiteCoord(v);

/** The GAP between two rects' AABBs (0 when they overlap or touch on both axes) — the intuitive "within N px
 *  of each other" distance. Default metric. */
export function rectGap(a: ClusterRect, b: ClusterRect): number {
  const ax0 = fx(a.x);
  const ay0 = fx(a.y);
  const ax1 = ax0 + Math.max(0, fx(a.w));
  const ay1 = ay0 + Math.max(0, fx(a.h));
  const bx0 = fx(b.x);
  const by0 = fx(b.y);
  const bx1 = bx0 + Math.max(0, fx(b.w));
  const by1 = by0 + Math.max(0, fx(b.h));
  const dx = Math.max(0, Math.max(ax0 - bx1, bx0 - ax1));
  const dy = Math.max(0, Math.max(ay0 - by1, by0 - ay1));
  return Math.hypot(dx, dy);
}

/** Centre-to-centre distance — the alternative metric (a pile is "centres within N px"). */
export function centerDistance(a: ClusterRect, b: ClusterRect): number {
  const acx = fx(a.x) + Math.max(0, fx(a.w)) / 2;
  const acy = fx(a.y) + Math.max(0, fx(a.h)) / 2;
  const bcx = fx(b.x) + Math.max(0, fx(b.w)) / 2;
  const bcy = fx(b.y) + Math.max(0, fx(b.h)) / 2;
  return Math.hypot(acx - bcx, acy - bcy);
}

export interface SpatialClusterOptions {
  /** Max metric distance for two items to be "reachable" (default 40). Finite ≥ 0. */
  readonly epsilon?: number;
  /** Neighbourhood size (incl. self) that makes a CORE point → a real pile. Default 2 (a pair is a pile;
   *  a lone item is noise). */
  readonly minPoints?: number;
  /** Distance metric (default {@link rectGap}). */
  readonly metric?: ClusterMetric;
}

/**
 * DBSCAN over item footprints → a cluster label per rect, INDEX-ALIGNED with the input (`−1` = noise / not in
 * any pile, `0,1,2,…` = clusters in discovery order). Deterministic. A core point (≥ minPoints in its
 * ε-neighbourhood, counting itself) seeds/extends a cluster; border points (reachable from a core but not core
 * themselves) join the first cluster that reaches them; everything else is noise.
 */
export function spatialClusters(rects: readonly ClusterRect[], opts: SpatialClusterOptions = {}): number[] {
  const n = rects.length;
  const labels = new Array<number>(n).fill(-2); // -2 unvisited, -1 noise, ≥0 cluster
  if (n === 0) return [];
  const eps = Math.max(0, fx(opts.epsilon ?? 40));
  const minPts = Math.max(1, Math.floor(opts.minPoints ?? 2));
  const metric = opts.metric ?? rectGap;

  const neighborsOf = (i: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (metric(rects[i], rects[j]) <= eps) out.push(j);
    }
    return out;
  };

  let cid = -1;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    const nb = neighborsOf(i);
    if (nb.length + 1 < minPts) {
      labels[i] = -1; // not a core; provisionally noise (may be claimed as a border later)
      continue;
    }
    cid += 1;
    labels[i] = cid;
    // FIFO expansion (deterministic). seen = queued-or-labelled to this cluster.
    const queue = [...nb];
    const seen = new Set<number>(nb);
    seen.add(i);
    while (queue.length > 0) {
      const q = queue.shift()!;
      if (labels[q] === -1) labels[q] = cid; // a former-noise border point joins this cluster
      if (labels[q] !== -2) continue; // already assigned (to this or an earlier cluster) — keep it
      labels[q] = cid;
      const qnb = neighborsOf(q);
      if (qnb.length + 1 >= minPts) {
        for (const m of qnb) if (!seen.has(m)) { seen.add(m); queue.push(m); }
      }
    }
  }
  return labels;
}

/** Group input indices by their cluster label (noise excluded). Deterministic (ascending cluster id, then
 *  input order). Useful for "select this pile" + feeding each pile to the hull. */
export function clusterIndexGroups(labels: readonly number[]): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  labels.forEach((c, i) => {
    if (c < 0) return;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(i);
  });
  return groups;
}

/** Number of discovered clusters (excludes noise). */
export function clusterCount(labels: readonly number[]): number {
  let max = -1;
  for (const c of labels) if (c > max) max = c;
  return max + 1;
}
