// @vitest-environment jsdom
// packages/group/show/ClusterHullOverlay.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import {
  clusterHulls,
  ClusterHullOverlay,
  CLUSTER_FACETS,
  clusterFacetById,
  type ClusterFacet,
} from './ClusterHullOverlay';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const item = (memberId: string, x: number, y: number, extra: Record<string, unknown> = {}, kind = 'note'): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind, x, y, w: 80, h: 50, isSection: false, childCount: 0, extra } as BoardItem);

const tagFacet: ClusterFacet = { id: 'tag', label: 'by tag', keyOf: (i) => (i.extra.tags as string[])?.[0] };

describe('clusterHulls — pure projector', () => {
  it('produces one blob per distinct key, counting members', () => {
    const items = [
      item('a', 0, 0, { tags: ['red'] }),
      item('b', 200, 10, { tags: ['red'] }),
      item('c', 100, 200, { tags: ['blue'] }),
    ];
    const hulls = clusterHulls(items, { keyOf: tagFacet.keyOf });
    expect(hulls).toHaveLength(2);
    const red = hulls.find((h) => h.key === 'red')!;
    expect(red.count).toBe(2);
    expect(red.path.startsWith('M')).toBe(true);
    expect(hulls.find((h) => h.key === 'blue')!.count).toBe(1);
  });

  it('skips connectors and keyless items (no cluster)', () => {
    const items = [
      item('a', 0, 0, { tags: ['x'] }),
      item('edge', 5, 5, { fromMemberId: 'a', toMemberId: 'a', tags: ['x'] }), // connector → excluded
      item('n', 300, 0, {}), // no tag → no cluster
    ];
    const hulls = clusterHulls(items, { keyOf: tagFacet.keyOf });
    expect(hulls).toHaveLength(1);
    expect(hulls[0].count).toBe(1); // only 'a' (edge excluded despite carrying a tag)
  });

  it('respects minGroup (outline only real clusters)', () => {
    const items = [item('a', 0, 0, { tags: ['solo'] }), item('b', 100, 0, { tags: ['pair'] }), item('c', 130, 40, { tags: ['pair'] })];
    const hulls = clusterHulls(items, { keyOf: tagFacet.keyOf, minGroup: 2 });
    expect(hulls.map((h) => h.key)).toEqual(['pair']);
  });

  it('output order is deterministic (first-appearance of each key)', () => {
    const items = [item('a', 0, 0, { tags: ['z'] }), item('b', 50, 0, { tags: ['a'] }), item('c', 90, 0, { tags: ['z'] })];
    expect(clusterHulls(items, { keyOf: tagFacet.keyOf }).map((h) => h.key)).toEqual(['z', 'a']);
  });

  it('a single-item cluster gets a rounded-rect blob hugging its 4 corners (never NaN)', () => {
    const hulls = clusterHulls([item('a', 40, 40, { tags: ['solo'] })], { keyOf: tagFacet.keyOf });
    expect(hulls).toHaveLength(1);
    // one item = 4 rect corners → a 4-corner rounded blob (a Q fillet per corner)
    expect((hulls[0].path.match(/Q /g) ?? []).length).toBe(4);
    expect(/(NaN|Infinity)/.test(hulls[0].path)).toBe(false);
  });
});

describe('ClusterHullOverlay — component', () => {
  it('renders one <path> per cluster + a label with the count', () => {
    const items = [item('a', 0, 0, { tags: ['red'] }), item('b', 200, 10, { tags: ['red'] }), item('c', 100, 200, { tags: ['blue'] })];
    const { container } = render(
      <svg>
        <ClusterHullOverlay items={items} facet={tagFacet} />
      </svg>,
    );
    expect(container.querySelectorAll('path')).toHaveLength(2);
    expect(container.textContent).toContain('red · 2');
    expect(container.textContent).toContain('blue · 1');
  });

  it('showLabels=false hides labels but keeps blobs', () => {
    const items = [item('a', 0, 0, { tags: ['red'] }), item('b', 200, 10, { tags: ['red'] })];
    const { container } = render(
      <svg>
        <ClusterHullOverlay items={items} facet={tagFacet} showLabels={false} />
      </svg>,
    );
    expect(container.querySelectorAll('path')).toHaveLength(1);
    expect(container.querySelectorAll('text')).toHaveLength(0);
  });
});

describe('CLUSTER_FACETS catalog', () => {
  it('ships tag / kind / colour axes and resolves by id (fallback to first)', () => {
    expect(CLUSTER_FACETS.map((f) => f.id)).toEqual(['tag', 'kind', 'color']);
    expect(clusterFacetById('color').id).toBe('color');
    expect(clusterFacetById('nope').id).toBe('tag');
  });

  it('the kind facet groups by item.kind (a real accessor, not a hardcoded map)', () => {
    const kind = clusterFacetById('kind');
    const items = [item('a', 0, 0, {}, 'note'), item('b', 100, 0, {}, 'note'), item('c', 200, 0, {}, 'image')];
    const hulls = clusterHulls(items, { keyOf: kind.keyOf });
    expect(hulls.map((h) => `${h.key}:${h.count}`)).toEqual(['note:2', 'image:1']);
  });
});
