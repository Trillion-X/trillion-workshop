// packages/group/do-work/spatial-clusters.test.ts
import { describe, it, expect } from 'vitest';
import {
  spatialClusters,
  rectGap,
  centerDistance,
  clusterIndexGroups,
  clusterCount,
  type ClusterRect,
} from './spatial-clusters';

const r = (x: number, y: number, w = 40, h = 30): ClusterRect => ({ x, y, w, h });

describe('metrics', () => {
  it('rectGap is 0 for overlapping/touching, else the AABB gap', () => {
    expect(rectGap(r(0, 0), r(10, 5))).toBe(0); // overlap
    expect(rectGap(r(0, 0, 40, 30), r(50, 0, 40, 30))).toBe(10); // 10px horizontal gap
    expect(rectGap(r(0, 0, 40, 30), r(43, 40, 40, 30))).toBeCloseTo(Math.hypot(3, 10), 6);
  });
  it('centerDistance is centre-to-centre', () => {
    expect(centerDistance(r(0, 0, 40, 40), r(100, 0, 40, 40))).toBe(100);
  });
});

describe('spatialClusters — DBSCAN', () => {
  it('empty → []', () => {
    expect(spatialClusters([])).toEqual([]);
  });

  it('a lone item is NOISE (minPoints 2); a near pair is a cluster', () => {
    const lonely = spatialClusters([r(0, 0)], { epsilon: 40 });
    expect(lonely).toEqual([-1]);
    const pair = spatialClusters([r(0, 0), r(45, 0)], { epsilon: 20 }); // gap 5 ≤ 20
    expect(pair[0]).toBe(pair[1]);
    expect(pair[0]).toBeGreaterThanOrEqual(0);
  });

  it('two separated piles → two clusters; the far outlier is noise', () => {
    const rects = [
      r(0, 0), r(20, 10), r(10, 30), // pile A (mutually within ~20px)
      r(400, 400), r(420, 410), r(410, 430), // pile B
      r(900, 50), // outlier
    ];
    const labels = spatialClusters(rects, { epsilon: 30 });
    expect(clusterCount(labels)).toBe(2);
    // pile A shares one label, pile B another, and they differ
    expect(new Set([labels[0], labels[1], labels[2]]).size).toBe(1);
    expect(new Set([labels[3], labels[4], labels[5]]).size).toBe(1);
    expect(labels[0]).not.toBe(labels[3]);
    expect(labels[6]).toBe(-1); // outlier
  });

  it('a chain links transitively (density-reachable), unlike k-means round blobs', () => {
    // a-b-c-d each 25px apart in a line; epsilon 30 links the whole chain into ONE cluster
    const chain = [r(0, 0, 20, 20), r(45, 0, 20, 20), r(90, 0, 20, 20), r(135, 0, 20, 20)];
    const labels = spatialClusters(chain, { epsilon: 30, minPoints: 2 });
    expect(new Set(labels).size).toBe(1);
    expect(labels.every((l) => l === 0)).toBe(true);
  });

  it('epsilon controls granularity — tight epsilon splits a loose group into noise/pieces', () => {
    const rects = [r(0, 0, 20, 20), r(60, 0, 20, 20), r(120, 0, 20, 20)]; // gaps of 40
    expect(clusterCount(spatialClusters(rects, { epsilon: 50 }))).toBe(1); // all linked
    expect(clusterCount(spatialClusters(rects, { epsilon: 20 }))).toBe(0); // none reachable → all noise
  });

  it('minPoints raises the bar (a pair is noise when minPoints=3)', () => {
    const pair = spatialClusters([r(0, 0), r(10, 0)], { epsilon: 40, minPoints: 3 });
    expect(pair).toEqual([-1, -1]);
  });

  it('centerDistance metric groups by centres', () => {
    const rects = [r(0, 0, 10, 10), r(30, 0, 10, 10), r(500, 0, 10, 10)];
    const labels = spatialClusters(rects, { epsilon: 40, metric: centerDistance });
    expect(labels[0]).toBe(labels[1]);
    expect(labels[2]).toBe(-1);
  });

  it('is deterministic (same input → identical labels) and finite-safe (NaN/huge coords)', () => {
    const rects = [r(0, 0), r(20, 10), r(NaN, 5), r(1e30, 1e30)];
    expect(spatialClusters(rects, { epsilon: 30 })).toEqual(spatialClusters(rects, { epsilon: 30 }));
    for (const l of spatialClusters(rects, { epsilon: 30 })) expect(Number.isFinite(l)).toBe(true);
  });
});

describe('clusterIndexGroups / clusterCount', () => {
  it('groups indices by cluster (noise excluded), counts clusters', () => {
    const labels = [0, 0, -1, 1, 1, 1];
    const groups = clusterIndexGroups(labels);
    expect(groups.get(0)).toEqual([0, 1]);
    expect(groups.get(1)).toEqual([3, 4, 5]);
    expect(groups.has(-1)).toBe(false);
    expect(clusterCount(labels)).toBe(2);
  });
});
