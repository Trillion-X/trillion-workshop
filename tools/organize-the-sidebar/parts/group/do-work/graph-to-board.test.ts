// packages/group/do-work/graph-to-board.test.ts
//
// Proves b174's shared graph builder: graphDepths (dependency columns, cycle-safe) + graphToBoardItems (a card
// per node, a connector per edge). This is the ONE body Mermaid/GraphML/DOT importers now share.

import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { graphDepths, graphToBoardItems, type GraphNode, type GraphEdge } from '../../../do-work/graph-to-board.ts';

const nodes = (ids: string[]): GraphNode[] => ids.map((id) => ({ id, label: id.toUpperCase() }));

describe('graphDepths — longest-path dependency columns', () => {
  it('roots at 0, children at parent+1, longest path wins', () => {
    // a→b→d, a→c→d : d should be depth 2 (longest path a→b→d = a→c→d)
    const d = graphDepths(nodes(['a', 'b', 'c', 'd']), [
      { from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' },
    ]);
    expect(d.get('a')).toBe(0);
    expect(d.get('b')).toBe(1);
    expect(d.get('c')).toBe(1);
    expect(d.get('d')).toBe(2);
  });

  it('a cycle is bounded (nodes stay finite, no hang)', () => {
    const d = graphDepths(nodes(['x', 'y']), [{ from: 'x', to: 'y' }, { from: 'y', to: 'x' }]);
    expect(Number.isFinite(d.get('x'))).toBe(true);
    expect(Number.isFinite(d.get('y'))).toBe(true);
  });

  it('ignores edges to/from unknown ids', () => {
    const d = graphDepths(nodes(['a']), [{ from: 'a', to: 'ghost' }, { from: 'ghost', to: 'a' }]);
    expect(d.get('a')).toBe(0);
  });
});

describe('graphToBoardItems', () => {
  it('a card per node (left→right by depth, keyed by node id) + a connector per edge', () => {
    const items = graphToBoardItems(nodes(['a', 'b']), [{ from: 'a', to: 'b', relation: 'blocks' }], 40, 40);
    const cards = items.filter((i) => !i.extra?.fromMemberId);
    const conns = items.filter((i) => i.extra?.fromMemberId);
    expect(cards.map((c) => c.memberId)).toEqual(['a', 'b']);
    expect(cards.map((c) => c.text)).toEqual(['A', 'B']);
    expect(cards[0].x).toBe(40);
    expect(cards[1].x).toBe(40 + 240); // depth 1
    expect(conns).toHaveLength(1);
    expect(conns[0].extra).toMatchObject({ fromMemberId: 'a', toMemberId: 'b', relationKind: 'blocks' });
  });

  it('drops an edge to an unknown id; omits relationKind when no relation', () => {
    const items = graphToBoardItems(nodes(['a', 'b']), [{ from: 'a', to: 'b' }, { from: 'a', to: 'ghost' }]);
    const conns = items.filter((i) => i.extra?.fromMemberId);
    expect(conns).toHaveLength(1);
    expect((conns[0].extra as Record<string, unknown>).relationKind).toBeUndefined();
  });

  it('empty / node-less → []', () => {
    expect(graphToBoardItems([], [])).toEqual([]);
  });
});
