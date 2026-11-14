// @vitest-environment jsdom
// packages/group/show/TreemapOverlay.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import {
  treemapCells,
  TreemapOverlay,
  TREEMAP_VALUES,
  treemapValueById,
} from './TreemapOverlay';
import type { BoardItem } from '../read-data/group-board-model';
import type { TreemapBounds } from '../do-work/treemap';

afterEach(() => cleanup());

const B: TreemapBounds = { x: 0, y: 0, w: 600, h: 400 };
const note = (memberId: string, text: string, extra: Record<string, unknown> = {}): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 100, h: 60, text, isSection: false, childCount: 0, extra } as BoardItem);

const votes = treemapValueById('votes');

describe('treemapCells', () => {
  it('sizes each item by the injected value, biggest value → biggest tile', () => {
    const items = [note('a', 'A', { votes: 1 }), note('b', 'B', { votes: 9 }), note('c', 'C', { votes: 3 })];
    const cells = treemapCells(items, { valueOf: votes.valueOf, bounds: B });
    const big = cells.reduce((m, c) => (c.w * c.h > m.w * m.h ? c : m));
    expect(big.item.memberId).toBe('b'); // votes 9
    // area conservation
    const sum = cells.reduce((s, c) => s + c.w * c.h, 0);
    expect(sum).toBeCloseTo(B.w * B.h, 2);
  });

  it('excludes connectors and drops zero-value items', () => {
    const items = [
      note('a', 'A', { votes: 5 }),
      note('b', 'B', { votes: 0 }), // no value → no tile
      { ...note('e', 'E', { votes: 5, fromMemberId: 'a', toMemberId: 'a' }) } as BoardItem, // connector
    ];
    const cells = treemapCells(items, { valueOf: votes.valueOf, bounds: B });
    expect(cells.map((c) => c.item.memberId)).toEqual(['a']);
  });

  it('empty board / all-zero value → no tiles', () => {
    expect(treemapCells([], { valueOf: votes.valueOf, bounds: B })).toEqual([]);
    const items = [note('a', 'A', { votes: 0 })];
    expect(treemapCells(items, { valueOf: votes.valueOf, bounds: B })).toEqual([]);
  });
});

describe('TreemapOverlay component', () => {
  it('renders one <rect> per tile; clicking fires onPick', () => {
    const items = [note('a', 'Alpha', { votes: 4 }), note('b', 'Beta', { votes: 6 })];
    const picked: string[] = [];
    const { container } = render(
      <svg>
        <TreemapOverlay items={items} value={votes} bounds={B} onPick={(it) => picked.push(it.memberId)} />
      </svg>,
    );
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBe(2);
    fireEvent.click(rects[0].parentElement!);
    expect(picked.length).toBe(1);
  });
});

describe('TREEMAP_VALUES catalog', () => {
  it('ships count/votes/progress/words/area + resolves by id (fallback to count)', () => {
    expect(TREEMAP_VALUES.map((v) => v.id)).toEqual(['count', 'votes', 'progress', 'words', 'area']);
    expect(treemapValueById('area').id).toBe('area');
    expect(treemapValueById('nope').id).toBe('count');
  });
  it('count value → equal tiles (each value 1)', () => {
    const items = [note('a', 'A'), note('b', 'B'), note('c', 'C'), note('d', 'D')];
    const cells = treemapCells(items, { valueOf: treemapValueById('count').valueOf, bounds: B });
    const areas = cells.map((c) => c.w * c.h);
    for (const a of areas) expect(a).toBeCloseTo(areas[0], 1); // all equal
  });
  it('words value sizes by word count', () => {
    const items = [note('a', 'one'), note('b', 'two three four five six')];
    const cells = treemapCells(items, { valueOf: treemapValueById('words').valueOf, bounds: B });
    const a = cells.find((c) => c.item.memberId === 'a')!;
    const b = cells.find((c) => c.item.memberId === 'b')!;
    expect(b.w * b.h).toBeGreaterThan(a.w * a.h);
  });
});
