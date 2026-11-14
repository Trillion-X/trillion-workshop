// packages/group/do-work/reading-tour-actions.test.ts
import { describe, it, expect } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import { stepAt, nextIndex, tourProgressLabel } from '../read-data/walkthrough';
import { readingTour } from './reading-tour-actions';

const card = (memberId: string, x: number, y: number, text: string): BoardItem =>
  ({ memberId, kind: 'note', x, y, w: 100, h: 60, text, extra: {}, isSection: false } as unknown as BoardItem);

// two rows: (a,b) at y=0 left→right, (c,d) at y=300 left→right → reading order a,b,c,d
const board: BoardItem[] = [
  card('b', 200, 0, 'Top right'),
  card('a', 0, 0, 'Top left'),
  card('d', 200, 300, 'Bottom right'),
  card('c', 0, 300, 'Bottom left'),
];
const label = (id: string) => board.find((i) => i.memberId === id)?.text ?? id;

describe('readingTour — a Tour generated from spatial reading order', () => {
  it('emits one step per card in reading order, each targeting that card', () => {
    const tour = readingTour(board, label);
    expect(tour.id).toBe('reading-order');
    expect(tour.name).toBe('Read in order');
    expect(tour.steps.map((s) => s.target)).toEqual(['a', 'b', 'c', 'd']); // row-band top→bottom, left→right
    expect(tour.steps.map((s) => s.title)).toEqual(['Top left', 'Top right', 'Bottom left', 'Bottom right']);
    expect(tour.steps.map((s) => s.body)).toEqual(['1 of 4', '2 of 4', '3 of 4', '4 of 4']);
  });

  it('falls back to a positional title when a card has no text', () => {
    const b2 = [card('a', 0, 0, ''), card('b', 200, 0, 'named')];
    const tour = readingTour(b2, (id) => (id === 'a' ? '' : 'named'));
    expect(tour.steps[0].title).toBe('Card 1'); // empty text → positional
    expect(tour.steps[1].title).toBe('named');
  });

  it('drives the EXISTING walkthrough navigation unchanged (reuse, not reimplement)', () => {
    const tour = readingTour(board, label);
    expect(stepAt(tour, 0)?.target).toBe('a');
    expect(stepAt(tour, nextIndex(tour, 0))?.target).toBe('b'); // next steps to the 2nd reading-order card
    expect(tourProgressLabel(0, tour.steps.length)).toBe('1 of 4');
    // nextIndex clamps at the end (walkthrough's own clamp — no custom nav here)
    expect(nextIndex(tour, 3)).toBe(3);
  });

  it('an empty board → a zero-step tour (overlay simply shows nothing to walk)', () => {
    const tour = readingTour([], label);
    expect(tour.steps).toEqual([]);
    expect(tour.id).toBe('reading-order');
  });
});
