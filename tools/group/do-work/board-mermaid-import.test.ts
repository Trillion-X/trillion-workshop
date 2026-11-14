// packages/group/do-work/board-mermaid-import.test.ts
import { describe, it, expect } from 'vitest';
import { looksLikeMermaid, parseMermaid, mermaidToBoardItems } from './board-mermaid-import';
import { boardToMermaid } from './board-mermaid';
import type { BoardItem } from '../read-data/group-board-model';

const isConn = (i: BoardItem) => Boolean((i.extra as Record<string, unknown>)?.fromMemberId);

describe('looksLikeMermaid', () => {
  it('recognizes a flowchart/graph header, rejects other text', () => {
    expect(looksLikeMermaid('flowchart TD\n a-->b')).toBe(true);
    expect(looksLikeMermaid('graph LR\n a-->b')).toBe(true);
    expect(looksLikeMermaid('just a note')).toBe(false);
    expect(looksLikeMermaid('- a\n- b')).toBe(false);
  });
});

describe('parseMermaid', () => {
  it('parses nodes with labels and edges', () => {
    const p = parseMermaid('flowchart TD\n  n0["Spec"]\n  n1["Build"]\n  n0 --> n1');
    expect(p.nodes).toEqual([{ id: 'n0', label: 'Spec' }, { id: 'n1', label: 'Build' }]);
    expect(p.edges).toEqual([{ from: 'n0', to: 'n1' }]);
  });

  it('captures an edge label as the edge label', () => {
    const p = parseMermaid('flowchart TD\n a --> |depends-on| b');
    expect(p.edges).toEqual([{ from: 'a', to: 'b', label: 'depends-on' }]);
  });

  it('handles inline-declared endpoints (A[Start] --> B[End])', () => {
    const p = parseMermaid('flowchart LR\n A[Start] --> B[End]');
    expect(p.nodes).toEqual([{ id: 'A', label: 'Start' }, { id: 'B', label: 'End' }]);
    expect(p.edges).toEqual([{ from: 'A', to: 'B' }]);
  });

  it('un-escapes the export entities (#quot;)', () => {
    expect(parseMermaid('flowchart TD\n n0["say #quot;hi#quot;"]').nodes[0].label).toBe('say "hi"');
  });

  it('a bare id with no label uses the id as the label', () => {
    expect(parseMermaid('flowchart TD\n a --> b').nodes).toEqual([{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }]);
  });

  it('ignores header, comments and subgraph/end lines', () => {
    const p = parseMermaid('flowchart TD\n %% a comment\n subgraph S\n a-->b\n end');
    expect(p.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(p.edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('round-trips a b134 export: boardToMermaid → parseMermaid recovers the graph', () => {
    const board: BoardItem[] = [
      { memberId: 'a', kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text: 'Spec', extra: {}, nodeRef: {} } as unknown as BoardItem,
      { memberId: 'b', kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text: 'Build', extra: {}, nodeRef: {} } as unknown as BoardItem,
      { memberId: 'c1', kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, extra: { fromMemberId: 'a', toMemberId: 'b', relationKind: 'depends-on' }, nodeRef: {} } as unknown as BoardItem,
    ];
    const mermaid = boardToMermaid(board);
    const p = parseMermaid(mermaid);
    expect(p.nodes.map((n) => n.label).sort()).toEqual(['Build', 'Spec']);
    expect(p.edges.length).toBe(1);
    expect(p.edges[0].label).toBe('depends-on');
  });
});

describe('mermaidToBoardItems', () => {
  it('produces a card per node and a connector per edge', () => {
    const items = mermaidToBoardItems('flowchart TD\n a["A"]\n b["B"]\n a --> b');
    const cards = items.filter((i) => !isConn(i));
    const conns = items.filter(isConn);
    expect(cards.map((c) => c.text)).toEqual(['A', 'B']);
    expect(conns.length).toBe(1);
    expect((conns[0].extra as Record<string, unknown>).fromMemberId).toBe('a');
    expect((conns[0].extra as Record<string, unknown>).toMemberId).toBe('b');
  });

  it('lays nodes out in dependency columns (deeper node further right)', () => {
    const items = mermaidToBoardItems('flowchart LR\n a --> b\n b --> c');
    const byId = new Map(items.filter((i) => !isConn(i)).map((i) => [i.memberId, i]));
    expect((byId.get('a') as BoardItem).x).toBeLessThan((byId.get('b') as BoardItem).x);
    expect((byId.get('b') as BoardItem).x).toBeLessThan((byId.get('c') as BoardItem).x);
  });

  it('carries the edge label as the connector relationKind', () => {
    const items = mermaidToBoardItems('flowchart TD\n a -->|blocks| b');
    const conn = items.find(isConn)!;
    expect((conn.extra as Record<string, unknown>).relationKind).toBe('blocks');
  });

  it('is empty for non-mermaid / empty input', () => {
    expect(mermaidToBoardItems('')).toEqual([]);
    expect(mermaidToBoardItems('flowchart TD')).toEqual([]);
  });
});
