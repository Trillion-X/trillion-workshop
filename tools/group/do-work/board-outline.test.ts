// packages/group/do-work/board-outline.test.ts
import { describe, it, expect } from 'vitest';
import { boardOutline, outlineCardTotal } from './board-outline';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string, x: number, y: number, w = 40, h = 30): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x, y, w, h, isSection: false, childCount: 0, extra: {} } as BoardItem);

const frame = (memberId: string, x: number, y: number, w: number, h: number, order: number, caption?: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x, y, w, h, isSection: false, childCount: 0,
     extra: { presentationFrame: { order }, ...(caption ? { frameCaption: caption } : {}) } } as BoardItem);

const connector = (memberId: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 10, h: 10, isSection: false, childCount: 0, extra: { fromMemberId: 'a', toMemberId: 'b' } } as BoardItem);

describe('boardOutline', () => {
  // Two frames "Ideas" (order 0) and "Done" (order 1); cards inside each; one loose card outside both.
  const board: BoardItem[] = [
    frame('fIdeas', 0, 0, 200, 200, 0, 'Ideas'),
    frame('fDone', 400, 0, 200, 200, 1, 'Done'),
    card('i1', 20, 120), // inside Ideas (lower)
    card('i2', 20, 20), //  inside Ideas (upper)
    card('d1', 420, 20), // inside Done
    card('loose', 900, 900), // outside both
    connector('e1'),
  ];

  it('lists a section per frame in presentation order, then the loose bucket', () => {
    const out = boardOutline(board);
    expect(out.map((e) => e.caption)).toEqual(['Ideas', 'Done', 'Loose cards']);
    expect(out[0].frameId).toBe('fIdeas');
    expect(out[2].frameId).toBeNull();
  });
  it('assigns each card to its frame in reading order (top→bottom)', () => {
    const out = boardOutline(board);
    expect(out[0].memberIds).toEqual(['i2', 'i1']); // i2 (y=20) before i1 (y=120)
    expect(out[0].cardCount).toBe(2);
    expect(out[1].memberIds).toEqual(['d1']);
    expect(out[2].memberIds).toEqual(['loose']);
  });
  it('never counts a connector as a card', () => {
    const out = boardOutline(board);
    const all = out.flatMap((e) => e.memberIds);
    expect(all).not.toContain('e1');
  });
  it('every card lands in exactly one section (no double-listing across overlapping frames)', () => {
    // Two overlapping frames; a card centre inside BOTH → the earlier-ordered frame claims it.
    const overlap: BoardItem[] = [
      frame('fA', 0, 0, 300, 300, 0, 'A'),
      frame('fB', 100, 100, 300, 300, 1, 'B'),
      card('shared', 150, 150), // centre inside both fA and fB
    ];
    const out = boardOutline(overlap);
    const inA = out.find((e) => e.frameId === 'fA')!;
    const inB = out.find((e) => e.frameId === 'fB')!;
    expect(inA.memberIds).toContain('shared');
    expect(inB.memberIds).not.toContain('shared'); // claimed by the earlier frame only
  });
  it('lists an empty frame as an empty section', () => {
    const out = boardOutline([frame('fEmpty', 0, 0, 100, 100, 0, 'Empty')]);
    expect(out).toHaveLength(1);
    expect(out[0].cardCount).toBe(0);
    expect(out[0].memberIds).toEqual([]);
  });
  it('falls back to "Section N" when a frame has no caption', () => {
    const out = boardOutline([frame('f0', 0, 0, 100, 100, 0)]);
    expect(out[0].caption).toBe('Section 1');
  });
  it('a board with no frames is just the loose bucket', () => {
    const out = boardOutline([card('a', 0, 0), card('b', 50, 0)]);
    expect(out).toHaveLength(1);
    expect(out[0].frameId).toBeNull();
    expect(out[0].cardCount).toBe(2);
  });
  it('an empty board yields no sections', () => {
    expect(boardOutline([])).toEqual([]);
  });
  it('is deterministic', () => {
    expect(boardOutline(board)).toEqual(boardOutline(board));
  });
});

describe('outlineCardTotal', () => {
  it('sums every section — every card counted exactly once', () => {
    const board = [
      frame('f', 0, 0, 200, 200, 0, 'F'),
      card('a', 20, 20),
      card('b', 20, 60),
      card('loose', 900, 900),
    ];
    expect(outlineCardTotal(boardOutline(board))).toBe(3);
  });
});
