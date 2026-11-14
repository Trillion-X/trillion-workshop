// packages/group/read-data/board-split-candidates.test.ts
import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  boardSplitCandidates,
  splitCandidateIds,
  boardHasSplitCandidates,
  splitCandidatesText,
} from './board-split-candidates';

const card = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId }, kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text, extra: {} } as unknown as BoardItem);

const connector = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId }, kind: 'connector', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text, extra: { fromMemberId: 'a', toMemberId: 'b' } } as unknown as BoardItem);

const furniture = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId }, kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text, extra: { regionHeading: true } } as unknown as BoardItem);

describe('board-split-candidates', () => {
  it('flags multi-segment cards; a single-line card is not a candidate', () => {
    const items = [
      card('c1', 'Buy milk\nCall bob\nPay rent'), // 3 segments
      card('c2', 'Just one line'), // 1 segment
      card('c3', ''), // 0
    ];
    const cands = boardSplitCandidates(items);
    expect(cands.map((c) => c.memberId)).toEqual(['c1']);
    expect(cands[0].segmentCount).toBe(3);
    expect(cands[0].title).toBe('Buy milk');
  });

  it('ranks by segment-count desc (most-splittable first)', () => {
    const items = [
      card('c1', 'a\nb'), // 2
      card('c2', 'x\ny\nz\nw'), // 4
      card('c3', 'p\nq\nr'), // 3
    ];
    expect(boardSplitCandidates(items).map((c) => `${c.memberId}:${c.segmentCount}`)).toEqual([
      'c2:4',
      'c3:3',
      'c1:2',
    ]);
  });

  it('counts bullet/numbered lines as segments (composes splitSegments stripping)', () => {
    const items = [card('c1', '- first\n- second\n- third')];
    const c = boardSplitCandidates(items)[0];
    expect(c.segmentCount).toBe(3); // splitSegments strips the "- " markers
    expect(c.title).toBe('- first'); // cardTitle is the raw first line
  });

  it('excludes connectors and furniture', () => {
    const items = [
      card('c1', 'one line only'),
      connector('e1', 'edge\nline\ntwo'), // must NOT be a candidate
      furniture('h1', 'heading\nline\ntwo'), // must NOT be a candidate
    ];
    expect(boardSplitCandidates(items)).toEqual([]);
  });

  it('splitCandidateIds sorted; boardHasSplitCandidates; empty honest text', () => {
    const items = [card('c2', 'a\nb'), card('c1', 'x\ny\nz'), card('c3', 'single')];
    expect(splitCandidateIds(items)).toEqual(['c1', 'c2']);
    expect(boardHasSplitCandidates(items)).toBe(true);
    const none = [card('c1', 'single'), card('c2', 'also single')];
    expect(boardHasSplitCandidates(none)).toBe(false);
    expect(splitCandidatesText(none)).toBe('## Cards to split\n- No cards to split');
  });

  it('splitCandidatesText lists title + section count with a title header', () => {
    const items = [card('c1', 'Groceries\nMilk\nEggs'), card('c2', 'Plan\nStep 1')];
    expect(splitCandidatesText(items, 'Board')).toBe(
      '# Board\n\n## Cards to split\n- Groceries — 3 sections\n- Plan — 2 sections',
    );
  });

  it('respects injected minSegments and limit', () => {
    const items = [card('c1', 'a\nb'), card('c2', 'x\ny\nz'), card('c3', 'p\nq\nr\ns')];
    // minSegments 3 drops the 2-segment card; limit 1 keeps the most-splittable
    const cands = boardSplitCandidates(items, { minSegments: 3, limit: 1 });
    expect(cands.length).toBe(1);
    expect(cands[0].memberId).toBe('c3'); // 4 segments
  });

  it('untitled multi-segment card renders "(untitled)" in text', () => {
    const items = [card('c1', '\nsecond\nthird')]; // first line empty -> cardTitle '' -> '(untitled)'
    expect(splitCandidatesText(items)).toBe('## Cards to split\n- (untitled) — 2 sections');
  });
});
