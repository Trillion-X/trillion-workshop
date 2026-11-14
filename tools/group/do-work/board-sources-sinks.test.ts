// packages/group/do-work/board-sources-sinks.test.ts
import { describe, it, expect } from 'vitest';
import { boardSources, boardSinks, boardHasSources, boardHasSinks, sourcesSinksText } from './board-sources-sinks';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text: memberId, extra: {} } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

// a -> b -> c  (chain) ; plus a loose card d ; plus a -> e (a fans out)
const flow = (): BoardItem[] => [
  card('a'), card('b'), card('c'), card('d'), card('e'),
  conn('e1', 'a', 'b'), conn('e2', 'b', 'c'), conn('e3', 'a', 'e'),
];

describe('boardSources', () => {
  it('is the in-degree-0, out-degree>=1 cards (the starting points)', () => {
    expect(boardSources(flow())).toEqual(['a']); // only a has no incoming and has outgoing
  });

  it('an isolated card (no edges) is NOT a source', () => {
    expect(boardSources(flow())).not.toContain('d');
  });

  it('multiple independent starts are all sources', () => {
    const items = [card('a'), card('b'), card('x'), card('y'), conn('e1', 'a', 'b'), conn('e2', 'x', 'y')];
    expect(boardSources(items)).toEqual(['a', 'x']);
  });
});

describe('boardSinks', () => {
  it('is the out-degree-0, in-degree>=1 cards (the final outcomes)', () => {
    expect(boardSinks(flow())).toEqual(['c', 'e']); // c and e are terminal, sorted
  });

  it('an isolated card is NOT a sink', () => {
    expect(boardSinks(flow())).not.toContain('d');
  });

  it('a mid-chain card (both in and out) is neither source nor sink', () => {
    const items = flow();
    expect(boardSources(items)).not.toContain('b');
    expect(boardSinks(items)).not.toContain('b');
  });
});

describe('boardHasSources / boardHasSinks', () => {
  it('gate on presence', () => {
    expect(boardHasSources(flow())).toBe(true);
    expect(boardHasSinks(flow())).toBe(true);
    // a board with no connectors has no flow
    expect(boardHasSources([card('a'), card('b')])).toBe(false);
    expect(boardHasSinks([card('a'), card('b')])).toBe(false);
  });

  it('a 2-cycle (a<->b) has neither a source nor a sink (every node has in AND out)', () => {
    const items = [card('a'), card('b'), conn('e1', 'a', 'b'), conn('e2', 'b', 'a')];
    expect(boardHasSources(items)).toBe(false);
    expect(boardHasSinks(items)).toBe(false);
  });
});

describe('sourcesSinksText', () => {
  it('reports both lists', () => {
    expect(sourcesSinksText(flow(), 'Plan')).toBe(
      ['# Plan', '', '## Starting points (1)', '- a', '', '## Final outcomes (2)', '- c', '- e'].join('\n'),
    );
  });

  it('honest empty when there is no flow', () => {
    expect(sourcesSinksText([card('a'), card('b')])).toBe('No dependency flow');
  });
});
