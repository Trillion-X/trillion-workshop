// @vitest-environment jsdom
// packages/group/show/content-similar-facet.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { contentSimilarFacet, rankSimilarItems } from './content-similar-facet';
import { ClusterHullOverlay } from './ClusterHullOverlay';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const note = (memberId: string, text: string, x = 0, y = 0, extra: Record<string, unknown> = {}): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x, y, w: 120, h: 60, text, isSection: false, childCount: 0, extra } as BoardItem);

describe('contentSimilarFacet', () => {
  it('groups near-duplicate notes by content; unique notes carry no key', () => {
    const items = [
      note('a', 'book the flight to nyc', 0, 0),
      note('b', 'book the flight to nyc please', 200, 0),
      note('c', 'walk the dog in the park', 0, 200),
    ];
    const { facet, groupCount, keyByMember } = contentSimilarFacet(items, { threshold: 0.3 });
    expect(groupCount).toBe(1);
    expect(facet.keyOf(items[0])).toBe(facet.keyOf(items[1])); // duplicates share a key
    expect(facet.keyOf(items[2])).toBeUndefined(); // unique note → no group
    expect(keyByMember.has('c')).toBe(false);
  });

  it('excludes connectors', () => {
    const items = [
      note('a', 'same text here', 0, 0),
      note('b', 'same text here', 200, 0),
      { ...note('e', 'same text here', 5, 5), extra: { fromMemberId: 'a', toMemberId: 'b' } } as BoardItem,
    ];
    const { facet } = contentSimilarFacet(items, { threshold: 0.5 });
    expect(facet.keyOf(items[2])).toBeUndefined();
  });

  it('labels default to "Similar N", overridable', () => {
    const items = [note('a', 'exact same note', 0, 0), note('b', 'exact same note', 200, 0)];
    const def = contentSimilarFacet(items, { threshold: 0.5 });
    expect(def.facet.labelOf!(def.facet.keyOf(items[0])!)).toBe('Similar 1');
    const custom = contentSimilarFacet(items, { threshold: 0.5, labelOf: (id) => `Dupe #${id + 1}` });
    expect(custom.facet.labelOf!(custom.facet.keyOf(items[0])!)).toBe('Dupe #1');
  });

  it('drives ClusterHullOverlay to outline the duplicate group', () => {
    const items = [
      note('a', 'quarterly planning notes', 0, 0),
      note('b', 'quarterly planning notes draft', 200, 20),
      note('c', 'lunch with sam', 0, 200),
    ];
    const { facet } = contentSimilarFacet(items, { threshold: 0.3 });
    const { container } = render(
      <svg>
        <ClusterHullOverlay items={items} facet={facet} />
      </svg>,
    );
    expect(container.querySelectorAll('path')).toHaveLength(1); // one blob around the duplicate pair
    expect(container.textContent).toContain('Similar 1');
  });
});

describe('rankSimilarItems', () => {
  it('ranks other notes by content similarity, excludes the target', () => {
    const items = [
      note('a', 'book flight to nyc', 0, 0),
      note('b', 'book flight to nyc soon', 200, 0),
      note('c', 'cook dinner tonight', 0, 200),
    ];
    const ranked = rankSimilarItems(items[0], items);
    expect(ranked[0].item.memberId).toBe('b'); // most similar
    expect(ranked.map((r) => r.item.memberId)).not.toContain('a'); // target excluded
  });
});
