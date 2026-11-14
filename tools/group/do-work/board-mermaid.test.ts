// packages/group/do-work/board-mermaid.test.ts
import { describe, it, expect } from 'vitest';
import { boardToMermaid } from './board-mermaid';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 40, h: 30, isSection: false, childCount: 0, text, extra: {} } as BoardItem);
const link = (memberId: string, from: string, to: string, relationKind?: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to, ...(relationKind ? { relationKind } : {}) } } as BoardItem);

describe('boardToMermaid', () => {
  it('emits a flowchart header (TD by default, LR when asked)', () => {
    expect(boardToMermaid([card('a', 'A')]).split('\n')[0]).toBe('flowchart TD');
    expect(boardToMermaid([card('a', 'A')], { direction: 'LR' }).split('\n')[0]).toBe('flowchart LR');
  });

  it('emits one node per card with its first-line label', () => {
    const out = boardToMermaid([card('a', 'Design\nmore detail'), card('b', 'Build')]);
    expect(out).toMatch(/\["Design"\]/); // first line only
    expect(out).toMatch(/\["Build"\]/);
  });

  it('emits an edge per connector, ids assigned in board order', () => {
    const out = boardToMermaid([card('a', 'A'), card('b', 'B'), link('c1', 'a', 'b')]);
    // a is first in board order -> n0, b -> n1
    expect(out).toMatch(/n0 --> n1/);
  });

  it('labels an edge with its relationship kind (default kind → unlabelled)', () => {
    const typed = boardToMermaid([card('a', 'A'), card('b', 'B'), link('c1', 'a', 'b', 'depends-on')]);
    expect(typed).toMatch(/n0 -->\|depends-on\| n1/);
    const bare = boardToMermaid([card('a', 'A'), card('b', 'B'), link('c1', 'a', 'b')]);
    expect(bare).not.toMatch(/-->\|/);
  });

  it('includes an isolated card as a lone node', () => {
    const out = boardToMermaid([card('a', 'A'), card('lonely', 'Lonely')]);
    expect(out).toMatch(/\["Lonely"\]/);
  });

  it('drops a dangling connector (endpoint with no card)', () => {
    const out = boardToMermaid([card('a', 'A'), card('b', 'B'), link('c1', 'a', 'b'), link('d', 'b', 'ghost')]);
    const edges = out.split('\n').filter((l) => l.includes('-->'));
    expect(edges.length).toBe(1); // only a->b; the b->ghost dangling edge is dropped
  });

  it('escapes quotes and pipes in a label so they cannot break the syntax', () => {
    const out = boardToMermaid([card('a', 'say "hi" | now')]);
    expect(out).toMatch(/#quot;hi#quot;/); // quotes → entity
    expect(out).not.toMatch(/"hi"/); // no raw quotes that would close the label
    expect(out).toMatch(/#quot; \/ now/); // the pipe was replaced with a slash
  });

  it('is deterministic for a fixed board order (same input → identical output)', () => {
    const parts = [card('a', 'A'), card('b', 'B'), card('c', 'C'), link('c1', 'a', 'b'), link('c2', 'b', 'c')];
    expect(boardToMermaid(parts)).toBe(boardToMermaid(parts));
    // ids follow board order: a=n0, b=n1, c=n2
    expect(boardToMermaid(parts)).toContain('n0 --> n1');
    expect(boardToMermaid(parts)).toContain('n1 --> n2');
  });
});
