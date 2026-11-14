// packages/group/read-data/board-connector-legend.test.ts
import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  connectorLegend,
  topRelationKind,
  cardIdsInTopRelationship,
  boardHasRelationships,
  connectorLegendText,
} from './board-connector-legend';

const card = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text: memberId, extra: {} } as unknown as BoardItem);

const conn = (memberId: string, from: string, to: string, kind: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to, relationKind: kind } } as unknown as BoardItem);

// n1..n4 nodes; blocks x3 (n1→n2, n2→n3, n1→n3), relates x2 (n3→n4, n1→n4).
const board = (): BoardItem[] => [
  card('n1'), card('n2'), card('n3'), card('n4'),
  conn('e1', 'n1', 'n2', 'blocks'),
  conn('e2', 'n2', 'n3', 'blocks'),
  conn('e3', 'n1', 'n3', 'blocks'),
  conn('e4', 'n3', 'n4', 'relates'),
  conn('e5', 'n1', 'n4', 'relates'),
];

describe('board-connector-legend', () => {
  it('tallies each relationship kind by connector count, ranked count desc then kind asc', () => {
    expect(connectorLegend(board())).toEqual([
      { kind: 'blocks', count: 3 },
      { kind: 'relates', count: 2 },
    ]);
  });

  it('drops dangling connectors (endpoint not on the board) — never counts a phantom edge', () => {
    const items = [...board(), conn('e6', 'n1', 'GHOST', 'blocks')]; // GHOST is not a node
    expect(connectorLegend(items).find((e) => e.kind === 'blocks')!.count).toBe(3); // still 3, not 4
  });

  it('a connector with no relationKind falls back to the default kind', () => {
    const items = [
      card('a'), card('b'),
      { kind: 'connector', memberId: 'e1', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a', toMemberId: 'b' } } as unknown as BoardItem,
    ];
    expect(connectorLegend(items)).toEqual([{ kind: 'relates-to', count: 1 }]); // DEFAULT_RELATION_KIND
  });

  it('topRelationKind + cardIdsInTopRelationship surface the dominant relationship', () => {
    expect(topRelationKind(board())).toBe('blocks');
    // blocks edges touch n1,n2,n3 (n1→n2, n2→n3, n1→n3)
    expect(cardIdsInTopRelationship(board())).toEqual(['n1', 'n2', 'n3']);
  });

  it('empty / no-connector board: empty legend, null top, empty select, false gate, honest text', () => {
    const items = [card('a'), card('b')];
    expect(connectorLegend(items)).toEqual([]);
    expect(topRelationKind(items)).toBeNull();
    expect(cardIdsInTopRelationship(items)).toEqual([]);
    expect(boardHasRelationships(items)).toBe(false);
    expect(connectorLegendText(items)).toBe('## Relationship legend\n- No connectors');
  });

  it('connectorLegendText lists kinds with counts + a title, pluralizes', () => {
    const items = [
      card('a'), card('b'), card('c'),
      conn('e1', 'a', 'b', 'blocks'),
      conn('e2', 'b', 'c', 'blocks'),
      conn('e3', 'a', 'c', 'relates'),
    ];
    expect(connectorLegendText(items, 'Diagram')).toBe(
      '# Diagram\n\n## Relationship legend\n- blocks — 2 connectors\n- relates — 1 connector',
    );
    expect(boardHasRelationships(items)).toBe(true);
  });

  it('respects limit', () => {
    expect(connectorLegend(board(), { limit: 1 })).toEqual([{ kind: 'blocks', count: 3 }]);
  });
});
