// @vitest-environment jsdom
// packages/group/show/BoardOutlineReadout.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { BoardOutlineReadout, cardLabel } from './BoardOutlineReadout';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const card = (memberId: string, x: number, y: number, text?: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x, y, w: 40, h: 30, isSection: false, childCount: 0, ...(text !== undefined ? { text } : {}), extra: {} } as BoardItem);
const frame = (memberId: string, x: number, y: number, w: number, h: number, order: number, caption: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x, y, w, h, isSection: false, childCount: 0, extra: { presentationFrame: { order }, frameCaption: caption } } as BoardItem);

const board: BoardItem[] = [
  frame('fIdeas', 0, 0, 200, 200, 0, 'Ideas'),
  frame('fDone', 400, 0, 200, 200, 1, 'Done'),
  card('i1', 20, 20, 'Sketch the hero'),
  card('i2', 20, 80, 'Interview users'),
  card('d1', 420, 20, 'Ship the landing page'),
  card('loose', 900, 900, 'Loose thought'),
];

describe('BoardOutlineReadout', () => {
  it('renders one row per section with its card count', () => {
    const { container } = render(<BoardOutlineReadout items={board} />);
    const rows = container.querySelectorAll('[data-outline-section]');
    expect(rows.length).toBe(3); // Ideas, Done, Loose
    expect(container.querySelector('[data-outline-section="fIdeas"]')!.textContent).toMatch(/Ideas/);
    expect(container.querySelector('[data-outline-section="fIdeas"]')!.textContent).toMatch(/2/);
    expect(container.querySelector('[data-outline-section="loose"]')!.textContent).toMatch(/Loose cards/);
  });
  it('shows a section + card summary', () => {
    const { container } = render(<BoardOutlineReadout items={board} />);
    expect(container.textContent).toMatch(/2 sections/); // two frames
    expect(container.textContent).toMatch(/4 cards/); // i1,i2,d1,loose
  });
  it('clicking a section selects its cards', () => {
    const picks: string[][] = [];
    const { container } = render(<BoardOutlineReadout items={board} onPickSection={(ids) => picks.push([...ids])} />);
    fireEvent.click(container.querySelector('[data-outline-section="fIdeas"]')!);
    expect(picks[0].sort()).toEqual(['i1', 'i2']);
  });
  it('shows a friendly empty state for an empty board', () => {
    const { container } = render(<BoardOutlineReadout items={[]} />);
    expect(container.querySelector('[data-outline-section]')).toBeNull();
    expect(container.textContent).toMatch(/Nothing on the board yet/i);
  });
  it('opening a section reveals its cards by label; clicking a card jumps to it', () => {
    const cardPicks: string[] = [];
    const { container } = render(<BoardOutlineReadout items={board} onPickCard={(id) => cardPicks.push(id)} />);
    // cards are hidden until the section is opened
    expect(container.querySelector('[data-outline-cards="fIdeas"]')).toBeNull();
    fireEvent.click(container.querySelector('[data-outline-section="fIdeas"]')!);
    const cards = container.querySelector('[data-outline-cards="fIdeas"]')!;
    expect(cards).toBeTruthy();
    expect(cards.textContent).toMatch(/Sketch the hero/);
    expect(cards.textContent).toMatch(/Interview users/);
    fireEvent.click(container.querySelector('[data-outline-card="i1"]')!);
    expect(cardPicks).toEqual(['i1']);
  });
  it('clicking an open section again collapses it', () => {
    const { container } = render(<BoardOutlineReadout items={board} />);
    fireEvent.click(container.querySelector('[data-outline-section="fIdeas"]')!);
    expect(container.querySelector('[data-outline-cards="fIdeas"]')).toBeTruthy();
    fireEvent.click(container.querySelector('[data-outline-section="fIdeas"]')!);
    expect(container.querySelector('[data-outline-cards="fIdeas"]')).toBeNull();
  });
  it('reorder controls appear on frame sections (not the loose bucket), boundary-aware', () => {
    const { container } = render(<BoardOutlineReadout items={board} onReorderSection={() => {}} />);
    // first frame: down only (no up); last frame: up only; loose bucket: no controls
    expect(container.querySelector('[data-outline-up="fIdeas"]')).toBeNull();
    expect(container.querySelector('[data-outline-down="fIdeas"]')).toBeTruthy();
    expect(container.querySelector('[data-outline-up="fDone"]')).toBeTruthy();
    expect(container.querySelector('[data-outline-down="fDone"]')).toBeNull();
    expect(container.querySelector('[data-outline-reorder="loose"]')).toBeNull();
  });
  it('clicking ▼ fires onReorderSection(frameId, +1) without toggling the section open', () => {
    const moves: Array<[string, number]> = [];
    const { container } = render(<BoardOutlineReadout items={board} onReorderSection={(id, dir) => moves.push([id, dir])} />);
    fireEvent.click(container.querySelector('[data-outline-down="fIdeas"]')!);
    expect(moves).toEqual([['fIdeas', 1]]);
    // reorder must NOT expand the section (stopPropagation)
    expect(container.querySelector('[data-outline-cards="fIdeas"]')).toBeNull();
  });
  it('no reorder controls when onReorderSection is absent', () => {
    const { container } = render(<BoardOutlineReadout items={board} />);
    expect(container.querySelector('[data-outline-reorder="fIdeas"]')).toBeNull();
  });
});

describe('cardLabel', () => {
  it('uses the first non-empty line of text', () => {
    expect(cardLabel(card('a', 0, 0, '  \nFirst real line\nsecond'))).toBe('First real line');
  });
  it('strips html when there is no plain text', () => {
    const withHtml = { ...card('h', 0, 0), html: '<p><b>Bold</b> idea</p>' } as BoardItem;
    expect(cardLabel(withHtml)).toBe('Bold idea');
  });
  it('caps a long label with an ellipsis', () => {
    const long = cardLabel(card('l', 0, 0, 'x'.repeat(80)));
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(45);
  });
  it('falls back to "Untitled card" for empty / missing', () => {
    expect(cardLabel(card('e', 0, 0, '   '))).toBe('Untitled card');
    expect(cardLabel(undefined)).toBe('Untitled card');
  });
});
