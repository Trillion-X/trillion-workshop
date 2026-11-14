// packages/group/do-work/board-importance-actions.test.ts
import { describe, it, expect } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import { importanceRows, importanceSummary } from './board-importance-actions';

// card + connector factories. A connector carries fromMemberId/toMemberId in extra (a directed endorsement).
const card = (memberId: string, text: string): BoardItem =>
  ({ memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, text, extra: {}, isSection: false } as unknown as BoardItem);
const link = (id: string, from: string, to: string): BoardItem =>
  ({ memberId: id, kind: 'connector', x: 0, y: 0, w: 0, h: 0, text: '', isSection: false, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

const label = (id: string) => ({ a: 'Core', b: 'Mid', c: 'Leaf', d: 'Leaf2' }[id] ?? id);

// b and c both endorse a; d endorses b. `a` is the transitive core (pointed at by the important `b`).
const board: BoardItem[] = [
  card('a', 'the core idea'), card('b', 'mid'), card('c', 'leaf'), card('d', 'leaf2'),
  link('e1', 'b', 'a'), link('e2', 'c', 'a'), link('e3', 'd', 'b'),
];

describe('importanceRows — PageRank rows for the core-ideas panel', () => {
  it('ranks the transitive core highest and resolves labels via the injected resolver', () => {
    const rows = importanceRows(board, label);
    expect(rows.map((r) => r.memberId)[0]).toBe('a'); // a is endorsed by b (itself endorsed) → top
    expect(rows[0].label).toBe('Core'); // injected label used
    expect(rows.every((r) => r.score > 0)).toBe(true);
    // scores sum to ~1 across ranked cards (connectors excluded)
    const total = rows.reduce((s, r) => s + r.score, 0);
    expect(total).toBeGreaterThan(0.99);
    expect(total).toBeLessThan(1.01);
    expect(rows).toHaveLength(4); // 4 cards, 0 connectors ranked
  });

  it('reports direct endorsers (in-degree) per card', () => {
    const rows = importanceRows(board, label);
    const byId = Object.fromEntries(rows.map((r) => [r.memberId, r.endorsers]));
    expect(byId.a).toBe(2); // b and c point at a
    expect(byId.b).toBe(1); // d points at b
    expect(byId.c).toBe(0);
    expect(byId.d).toBe(0);
  });

  it('caps to top-k and is deterministic (stable order across runs)', () => {
    const top2 = importanceRows(board, label, 2);
    expect(top2).toHaveLength(2);
    expect(top2.map((r) => r.memberId)).toEqual(importanceRows(board, label).slice(0, 2).map((r) => r.memberId));
    // determinism: same input → byte-identical scores
    expect(importanceRows(board, label)).toEqual(importanceRows(board, label));
  });

  it('empty board → no rows; summary reads zero', () => {
    expect(importanceRows([], label)).toEqual([]);
    expect(importanceSummary([])).toEqual({ ranked: 0, topShare: 0 });
  });

  it('summary reports the count ranked and the top card share', () => {
    const rows = importanceRows(board, label);
    const s = importanceSummary(rows);
    expect(s.ranked).toBe(4);
    expect(s.topShare).toBe(rows[0].score);
  });
});
