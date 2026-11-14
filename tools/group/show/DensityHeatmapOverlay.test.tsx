// @vitest-environment jsdom
// packages/group/show/DensityHeatmapOverlay.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import {
  heatmapCells,
  heatmapHotspot,
  DensityHeatmapOverlay,
  DENSITY_WEIGHTS,
  DENSITY_RAMPS,
  densityWeightById,
  densityRampById,
  numericFieldWeight,
} from './DensityHeatmapOverlay';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const item = (memberId: string, x: number, y: number, extra: Record<string, unknown> = {}): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x, y, w: 40, h: 40, isSection: false, childCount: 0, extra } as BoardItem);

const heat = DENSITY_RAMPS.heat;

describe('heatmapCells — pure projector', () => {
  it('empty / connector-only board → no cells', () => {
    expect(heatmapCells([], { ramp: heat })).toEqual([]);
    const edge = item('e', 0, 0, { fromMemberId: 'a', toMemberId: 'b' });
    expect(heatmapCells([edge], { ramp: heat })).toEqual([]);
  });

  it('a pile produces cells; the hottest cell has t up to 1 with a ramp colour', () => {
    const items = [item('a', 0, 0), item('b', 5, 5), item('c', 10, 0), item('lone', 400, 400)];
    const cells = heatmapCells(items, { ramp: heat, cellSize: 60 });
    expect(cells.length).toBeGreaterThan(0);
    const hottest = cells.reduce((m, c) => (c.t > m.t ? c : m));
    expect(hottest.t).toBeCloseTo(1, 5);
    expect(hottest.color).toMatch(/^rgb\(/);
  });

  it('floor drops sparse noise (higher floor → fewer cells)', () => {
    const items = [item('a', 0, 0), item('b', 5, 5), item('c', 300, 300)];
    const many = heatmapCells(items, { ramp: heat, cellSize: 60, floor: 0 });
    const few = heatmapCells(items, { ramp: heat, cellSize: 60, floor: 0.9 });
    expect(few.length).toBeLessThan(many.length);
  });

  it('injected weight changes the field (progress weight zeroes cards with no progress)', () => {
    const items = [item('a', 0, 0), item('b', 5, 5)];
    const zero = heatmapCells(items, { ramp: heat, cellSize: 60, weightOf: () => 0 });
    expect(zero).toEqual([]); // all weight 0 → no hot cells
  });
});

describe('heatmapHotspot', () => {
  it('null when nothing to weigh; else the busy region centre', () => {
    expect(heatmapHotspot([], {})).toBeNull();
    const items = [item('a', 0, 0), item('b', 4, 4), item('lone', 500, 500)];
    const hs = heatmapHotspot(items, { cellSize: 60 })!;
    expect(hs.value).toBe(1);
    expect(hs.center.x).toBeLessThan(120);
  });
});

describe('DensityHeatmapOverlay — component', () => {
  it('renders one <rect> per hot cell', () => {
    const items = [item('a', 0, 0), item('b', 5, 5), item('c', 10, 10)];
    const { container } = render(
      <svg>
        <DensityHeatmapOverlay items={items} weight={densityWeightById('count')} ramp={heat} cellSize={60} />
      </svg>,
    );
    expect(container.querySelectorAll('rect').length).toBeGreaterThan(0);
  });
});

describe('DATA catalogs', () => {
  it('DENSITY_WEIGHTS ships count / progress / votes and resolves by id (fallback to count)', () => {
    expect(DENSITY_WEIGHTS.map((w) => w.id)).toEqual(['count', 'progress', 'votes']);
    expect(densityWeightById('votes').id).toBe('votes');
    expect(densityWeightById('nope').id).toBe('count');
  });
  it('numericFieldWeight reads a numeric extra field, else 0', () => {
    const w = numericFieldWeight('votes');
    expect(w(item('a', 0, 0, { votes: 7 }))).toBe(7);
    expect(w(item('b', 0, 0, { votes: 'x' }))).toBe(0);
    expect(w(item('c', 0, 0, {}))).toBe(0);
  });
  it('DENSITY_RAMPS resolves by id (fallback to heat)', () => {
    expect(densityRampById('indigo')).toBe(DENSITY_RAMPS.indigo);
    expect(densityRampById('nope')).toBe(DENSITY_RAMPS.heat);
  });
});
