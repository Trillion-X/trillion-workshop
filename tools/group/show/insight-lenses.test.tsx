// @vitest-environment jsdom
// packages/group/show/insight-lenses.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import {
  INSIGHT_LENSES,
  lensById,
  lensesByGroup,
  boardContentBounds,
  InsightLensLayer,
  InsightLensSvg,
  InsightLensPicker,
} from './insight-lenses';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const note = (memberId: string, x: number, y: number, extra: Record<string, unknown> = {}, text = ''): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x, y, w: 80, h: 50, text, isSection: false, childCount: 0, extra } as BoardItem);

const board: BoardItem[] = [
  note('a', 0, 0, { tags: ['plan'], votes: 5 }, 'ship the release'),
  note('b', 40, 20, { tags: ['plan'], votes: 3 }, 'ship the release now'),
  note('c', 400, 300, { tags: ['idea'], votes: 8 }, 'new logo concept'),
];

describe('INSIGHT_LENSES catalog', () => {
  it('ships lenses grouped into Clusters / Density / Proportion', () => {
    expect(INSIGHT_LENSES.length).toBeGreaterThanOrEqual(6);
    expect(lensesByGroup().map((g) => g.group)).toEqual(['Clusters', 'Density', 'Proportion']);
    expect(lensById('treemap-votes')!.label).toBe('Treemap by votes');
    expect(lensById('nope')).toBeUndefined();
  });
});

describe('boardContentBounds', () => {
  it('is the padded extent of drawable items; empty → unit box', () => {
    const b = boardContentBounds([note('a', 10, 20)], 5);
    expect(b).toEqual({ x: 5, y: 15, w: 90, h: 60 });
    expect(boardContentBounds([])).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('InsightLensLayer — blind dispatch', () => {
  it('renders nothing when no/unknown lens', () => {
    const { container } = render(<svg><InsightLensLayer items={board} lensId={undefined} /></svg>);
    expect(container.querySelector('[data-insight-lens]')).toBeNull();
  });

  it('EVERY catalog lens dispatches (registry drives all); data-bearing lenses draw content', () => {
    // lenses whose data IS present on this board (progress heatmap is honestly empty — no progress data)
    const dataBearing = new Set(['clusters-tag', 'clusters-kind', 'clusters-spatial', 'duplicates', 'heatmap-density', 'treemap-votes']);
    for (const lens of INSIGHT_LENSES) {
      const { container } = render(<svg><InsightLensLayer items={board} lensId={lens.id} /></svg>);
      const g = container.querySelector(`[data-insight-lens="${lens.id}"]`);
      expect(g).not.toBeNull(); // dispatch works for every lens
      if (dataBearing.has(lens.id)) {
        expect(g!.querySelectorAll('path, rect').length).toBeGreaterThan(0); // draws a hull path / heatmap or treemap rect
      }
      cleanup();
    }
  });
});

describe('InsightLensSvg — the panel mount wrapper', () => {
  it('renders a world-space svg (pointer-events none) with the active lens, nothing when none', () => {
    const { container, rerender } = render(<InsightLensSvg items={board} lensId="clusters-tag" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('style')).toContain('pointer-events: none');
    expect(svg!.querySelector('[data-insight-lens="clusters-tag"]')).not.toBeNull();
    rerender(<InsightLensSvg items={board} lensId={undefined} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('InsightLensPicker', () => {
  it('lists every lens; clicking picks it, clicking the active one clears it', () => {
    const picks: (string | undefined)[] = [];
    const { getByText, rerender } = render(<InsightLensPicker activeId={undefined} onPick={(id) => picks.push(id)} />);
    for (const lens of INSIGHT_LENSES) expect(getByText(lens.label)).toBeTruthy();
    fireEvent.click(getByText('Density heatmap'));
    expect(picks).toEqual(['heatmap-density']);
    rerender(<InsightLensPicker activeId={'heatmap-density'} onPick={(id) => picks.push(id)} />);
    fireEvent.click(getByText('Density heatmap')); // active → toggle off
    expect(picks[1]).toBeUndefined();
  });
});
