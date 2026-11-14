// packages/group/do-work/board-dot.test.ts
//
// Proves b174's DOT/Graphviz format: the parser (edges, chains, node decls, quoted ids, comments), the
// export↔import ROUND-TRIP (boardToDot → parseDot), and dotToBoardItems (via the shared graph builder).

import { describe, it, expect } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import { looksLikeDot, parseDot, dotToBoardItems, boardToDot } from './board-dot';

function note(memberId: string, text: string): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, text, extra: {}, isSection: false } as unknown as BoardItem;
}
function connector(memberId: string, from: string, to: string, relationKind?: string): BoardItem {
  return { memberId, kind: 'note', x: 0, y: 0, w: 4, h: 4, extra: { fromMemberId: from, toMemberId: to, ...(relationKind ? { relationKind } : {}) }, isSection: false } as unknown as BoardItem;
}

describe('looksLikeDot', () => {
  it('recognizes digraph/graph headers, rejects other formats', () => {
    expect(looksLikeDot('digraph G { A -> B }')).toBe(true);
    expect(looksLikeDot('graph { A -- B }')).toBe(true);
    expect(looksLikeDot('flowchart TD\n A --> B')).toBe(false);
    expect(looksLikeDot('<graphml/>')).toBe(false);
    expect(looksLikeDot(undefined as unknown as string)).toBe(false);
  });
});

describe('parseDot — parser', () => {
  it('parses edges + a labelled node decl; label falls back to id', () => {
    const dot = `digraph G {
      A [label="Alpha"];
      A -> B;
      B -> C [label="blocks"];
    }`;
    const g = parseDot(dot);
    expect(g.nodes).toEqual([
      { id: 'A', label: 'Alpha' },
      { id: 'B', label: 'B' },
      { id: 'C', label: 'C' },
    ]);
    expect(g.edges).toEqual([
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C', relation: 'blocks' },
    ]);
  });

  it('handles chained edges (A -> B -> C) and undirected (--)', () => {
    expect(parseDot('digraph { A -> B -> C }').edges).toEqual([
      { from: 'A', to: 'B' }, { from: 'B', to: 'C' },
    ]);
    expect(parseDot('graph { X -- Y }').edges).toEqual([{ from: 'X', to: 'Y' }]);
  });

  it('handles quoted ids with spaces + strips comments', () => {
    const dot = 'digraph { /* c */ "Node one" -> "Node two"; // trailing\n }';
    const g = parseDot(dot);
    expect(g.nodes.map((n) => n.id)).toEqual(['Node one', 'Node two']);
    expect(g.edges).toEqual([{ from: 'Node one', to: 'Node two' }]);
  });

  it('ignores the header word + empty', () => {
    expect(parseDot('digraph MyGraph {\n}').nodes).toEqual([]);
    expect(parseDot('')).toEqual({ nodes: [], edges: [] });
  });
});

describe('ROUND-TRIP: boardToDot → parseDot', () => {
  it('recovers every node label and every edge (by label)', () => {
    const board: BoardItem[] = [
      note('a', 'Launch\nmore'), note('b', 'Marketing'), note('c', 'Product'),
      connector('e1', 'a', 'b', 'relates-to'), connector('e2', 'a', 'c', 'blocks'),
    ];
    const dot = boardToDot(board);
    expect(looksLikeDot(dot)).toBe(true);
    const g = parseDot(dot);
    expect(new Set(g.nodes.map((n) => n.label))).toEqual(new Set(['Launch', 'Marketing', 'Product']));
    const labelOf = new Map(g.nodes.map((n) => [n.id, n.label]));
    const edgeLabels = g.edges.map((e) => `${labelOf.get(e.from)}->${labelOf.get(e.to)}`).sort();
    expect(edgeLabels).toEqual(['Launch->Marketing', 'Launch->Product']);
    // a non-default relation kind round-trips as an edge label; the default 'relates-to' is omitted
    expect(g.edges.find((e) => labelOf.get(e.to) === 'Product')?.relation).toBe('blocks');
    expect(g.edges.find((e) => labelOf.get(e.to) === 'Marketing')?.relation).toBeUndefined();
  });

  it('a label with quotes survives the round-trip', () => {
    const board = [note('a', 'say "hi"'), note('b', 'plain'), connector('e1', 'a', 'b')];
    const g = parseDot(boardToDot(board));
    expect(g.nodes.map((n) => n.label).sort()).toEqual(['plain', 'say "hi"']);
  });
});

describe('dotToBoardItems', () => {
  it('a card per node + a connector per edge (via the shared builder)', () => {
    const items = dotToBoardItems('digraph { A [label="Root"]; A -> B [label="has"]; }', 40, 40);
    const cards = items.filter((i) => !i.extra?.fromMemberId);
    const conns = items.filter((i) => i.extra?.fromMemberId);
    expect(cards.map((c) => c.text)).toEqual(['Root', 'B']);
    expect(cards[1].x).toBe(40 + 240);
    expect(conns[0].extra).toMatchObject({ fromMemberId: 'A', toMemberId: 'B', relationKind: 'has' });
  });
});
