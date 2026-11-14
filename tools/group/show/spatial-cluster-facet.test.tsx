// @vitest-environment jsdom
// packages/group/show/spatial-cluster-facet.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { spatialClusterFacet } from './spatial-cluster-facet';
import { ClusterHullOverlay } from './ClusterHullOverlay';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const item = (memberId: string, x: number, y: number, extra: Record<string, unknown> = {}): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x, y, w: 40, h: 30, isSection: false, childCount: 0, extra } as BoardItem);

describe('spatialClusterFacet', () => {
  it('discovers piles from geometry and maps each clustered item to a key', () => {
    const items = [
      item('a', 0, 0), item('b', 20, 10), item('c', 10, 25), // pile 1
      item('d', 400, 400), item('e', 420, 410), // pile 2
      item('lone', 900, 50), // noise
    ];
    const { facet, clusterCount, keyByMember } = spatialClusterFacet(items, { epsilon: 30 });
    expect(clusterCount).toBe(2);
    expect(keyByMember.has('lone')).toBe(false); // noise → no key
    expect(facet.keyOf(items[0])).toBe(facet.keyOf(items[1])); // same pile
    expect(facet.keyOf(items[0])).not.toBe(facet.keyOf(items[3])); // different pile
    expect(facet.keyOf(items[5])).toBeUndefined(); // noise
  });

  it('excludes connectors from clustering', () => {
    const items = [
      item('a', 0, 0), item('b', 20, 10),
      item('edge', 5, 5, { fromMemberId: 'a', toMemberId: 'b' }),
    ];
    const { facet } = spatialClusterFacet(items, { epsilon: 30 });
    expect(facet.keyOf(items[2])).toBeUndefined(); // connector never clustered
  });

  it('labels default to "Cluster N" (1-based), overridable', () => {
    const items = [item('a', 0, 0), item('b', 20, 0)];
    const def = spatialClusterFacet(items, { epsilon: 30 });
    const key = def.facet.keyOf(items[0])!;
    expect(def.facet.labelOf!(key)).toBe('Cluster 1');
    const custom = spatialClusterFacet(items, { epsilon: 30, labelOf: (id) => `Zone ${String.fromCharCode(65 + id)}` });
    expect(custom.facet.labelOf!(custom.facet.keyOf(items[0])!)).toBe('Zone A');
  });

  it('drives ClusterHullOverlay to outline the DISCOVERED piles (no facet tagging)', () => {
    const items = [
      item('a', 0, 0), item('b', 20, 10), item('c', 10, 25),
      item('d', 400, 400), item('e', 420, 410),
    ];
    const { facet } = spatialClusterFacet(items, { epsilon: 30 });
    const { container } = render(
      <svg>
        <ClusterHullOverlay items={items} facet={facet} />
      </svg>,
    );
    expect(container.querySelectorAll('path')).toHaveLength(2); // one blob per discovered pile
    expect(container.textContent).toContain('Cluster 1');
    expect(container.textContent).toContain('Cluster 2');
  });
});
