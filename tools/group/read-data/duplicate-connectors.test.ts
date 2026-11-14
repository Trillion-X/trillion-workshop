// packages/group/read-data/duplicate-connectors.test.ts
import { describe, it, expect } from 'vitest';
import {
  duplicateConnectorGroups,
  redundantConnectorIds,
  boardHasDuplicateConnectors,
  duplicateConnectorsText,
} from './duplicate-connectors';
import type { BoardItem } from './group-board-model';

const card = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, text: memberId, extra: {} } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string, kind?: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to, ...(kind ? { relationKind: kind } : {}) } } as unknown as BoardItem);

describe('duplicateConnectorGroups', () => {
  it('groups ≥2 connectors with the identical (from,to,kind)', () => {
    const items = [card('a'), card('b'), conn('e1', 'a', 'b'), conn('e2', 'a', 'b')];
    const groups = duplicateConnectorGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ from: 'a', to: 'b', connectorIds: ['e1', 'e2'] });
  });

  it('a single connector is not a duplicate', () => {
    expect(duplicateConnectorGroups([card('a'), card('b'), conn('e1', 'a', 'b')])).toHaveLength(0);
  });

  it('DIFFERENT relation kinds between the same pair are NOT duplicates (typed pair, not double-draw)', () => {
    const items = [card('a'), card('b'), conn('e1', 'a', 'b', 'blocks'), conn('e2', 'a', 'b', 'relates-to')];
    expect(duplicateConnectorGroups(items)).toHaveLength(0);
  });

  it('direction matters — a→b and b→a are NOT a duplicate pair', () => {
    const items = [card('a'), card('b'), conn('e1', 'a', 'b'), conn('e2', 'b', 'a')];
    expect(duplicateConnectorGroups(items)).toHaveLength(0);
  });

  it('a dangling connector (endpoint off the board) never pairs with a real one', () => {
    const items = [card('a'), card('b'), conn('e1', 'a', 'b'), conn('e2', 'a', 'ghost')];
    expect(duplicateConnectorGroups(items)).toHaveLength(0);
  });

  it('three identical connectors → one group of three', () => {
    const items = [card('a'), card('b'), conn('e1', 'a', 'b'), conn('e2', 'a', 'b'), conn('e3', 'a', 'b')];
    expect(duplicateConnectorGroups(items)[0].connectorIds).toEqual(['e1', 'e2', 'e3']);
  });
});

describe('redundantConnectorIds', () => {
  it('is every duplicate except the first-kept one per group, sorted', () => {
    const items = [
      card('a'), card('b'), card('c'),
      conn('e1', 'a', 'b'), conn('e2', 'a', 'b'), conn('e3', 'a', 'b'), // keep e1, redundant e2,e3
      conn('e4', 'b', 'c'), conn('e5', 'b', 'c'), // keep e4, redundant e5
    ];
    expect(redundantConnectorIds(items)).toEqual(['e2', 'e3', 'e5']);
  });

  it('no duplicates → nothing redundant', () => {
    expect(redundantConnectorIds([card('a'), card('b'), conn('e1', 'a', 'b')])).toEqual([]);
  });
});

describe('boardHasDuplicateConnectors + duplicateConnectorsText', () => {
  it('gate reflects the groups', () => {
    expect(boardHasDuplicateConnectors([card('a'), card('b'), conn('e1', 'a', 'b'), conn('e2', 'a', 'b')])).toBe(true);
    expect(boardHasDuplicateConnectors([card('a'), card('b'), conn('e1', 'a', 'b')])).toBe(false);
  });

  it('reports each group with counts', () => {
    const items = [card('a'), card('b'), conn('e1', 'a', 'b', 'blocks'), conn('e2', 'a', 'b', 'blocks')];
    expect(duplicateConnectorsText(items, 'Links')).toBe(
      ['# Links', '', '## Duplicate connectors (1)', '- a → b (blocks) — 2 connectors, 1 redundant'].join('\n'),
    );
  });

  it('honest empty state', () => {
    expect(duplicateConnectorsText([card('a'), card('b'), conn('e1', 'a', 'b')])).toBe('No duplicate connectors');
  });
});
