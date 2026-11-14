// packages/group/show/connector-model.test.ts
//
// Deterministic proof of the connector PERSISTENCE path — the exact group-board-model
// calls the board makes when you drag A→B. A connector is just a member with two
// endpoint refs in its presentation; it must round-trip through placeItem→readItems
// like any item, be recognized as an EDGE by data shape (not a kind string), and be
// pruned when an endpoint is deleted. No DOM, no engine — pure model truth.

import { describe, it, expect } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import {
  placeItem,
  patchItem,
  readItems,
  removeItem,
  boardRootRef,
  itemRef,
  type BoardItem,
} from '../read-data/group-board-model';

// The board's shape-based edge test (mirrors GroupBoardPanel.itemIsConnector / the
// ConnectorLayer partition): an item is an edge iff it carries two endpoint refs.
const isConnector = (it: BoardItem) =>
  typeof it.extra?.fromMemberId === 'string' && typeof it.extra?.toMemberId === 'string';

const ROOT = boardRootRef('b1');
const place = (g: ReturnType<typeof emptyGraph>, id: string, extra?: Record<string, unknown>) =>
  placeItem(g, ROOT, { memberId: id, nodeRef: itemRef('b1', id), kind: extra ? 'connector' : 'note', x: 0, y: 0, w: extra ? 0 : 120, h: extra ? 0 : 80, extra });

describe('connector persistence (group-board-model)', () => {
  it('a connector member round-trips through placeItem → readItems as an edge with its endpoints', () => {
    let g = emptyGraph();
    g = place(g, 'a');
    g = place(g, 'b');
    g = place(g, 'c1', { fromMemberId: 'a', toMemberId: 'b' });

    const items = readItems(g, ROOT);
    expect(items.length).toBe(3);
    const edges = items.filter(isConnector);
    const nodes = items.filter((i) => !isConnector(i));
    expect(nodes.map((n) => n.memberId).sort()).toEqual(['a', 'b']);
    expect(edges.length).toBe(1);
    expect(edges[0].extra.fromMemberId).toBe('a');
    expect(edges[0].extra.toMemberId).toBe('b');
  });

  it('deleting an endpoint leaves the connector dangling → the prune predicate removes it', () => {
    let g = emptyGraph();
    g = place(g, 'a');
    g = place(g, 'b');
    g = place(g, 'c1', { fromMemberId: 'a', toMemberId: 'b' });

    // Delete item A, then run the board's prune: any connector referencing a deleted
    // endpoint is removed in the same step.
    const deleted = new Set(['a']);
    g = removeItem(g, ROOT, 'a');
    for (const it of readItems(g, ROOT)) {
      const f = it.extra?.fromMemberId;
      const t = it.extra?.toMemberId;
      if (typeof f === 'string' && typeof t === 'string' && (deleted.has(f) || deleted.has(t))) {
        g = removeItem(g, ROOT, it.memberId);
      }
    }
    const left = readItems(g, ROOT);
    expect(left.map((i) => i.memberId)).toEqual(['b']); // A gone, connector pruned, B kept
    expect(left.filter(isConnector).length).toBe(0);
  });

  it('re-anchoring an endpoint = patchItem on one ref → the edge points to the new item', () => {
    let g = emptyGraph();
    g = place(g, 'a');
    g = place(g, 'b');
    g = place(g, 'd');
    g = place(g, 'c1', { fromMemberId: 'a', toMemberId: 'b' });

    // Drag the 'to' endpoint from b onto d — the generic patchItem rewires it.
    g = patchItem(g, ROOT, 'c1', { toMemberId: 'd' });

    const edge = readItems(g, ROOT).filter(isConnector)[0];
    expect(edge.extra.fromMemberId).toBe('a'); // 'from' end unchanged
    expect(edge.extra.toMemberId).toBe('d'); // 'to' end rewired
  });

  it('labeling a connector = patchItem({label}) → the name persists on the edge', () => {
    let g = emptyGraph();
    g = place(g, 'a');
    g = place(g, 'b');
    g = place(g, 'c1', { fromMemberId: 'a', toMemberId: 'b' });
    g = patchItem(g, ROOT, 'c1', { label: 'blocks' });
    const edge = readItems(g, ROOT).filter(isConnector)[0];
    expect(edge.extra.label).toBe('blocks');
    // Clearing the label is the empty string.
    g = patchItem(g, ROOT, 'c1', { label: '' });
    expect(readItems(g, ROOT).filter(isConnector)[0].extra.label).toBe('');
  });

  it('styling a connector = patchItem({color,dashed,arrow}) → all persist on the edge', () => {
    let g = emptyGraph();
    g = place(g, 'a');
    g = place(g, 'b');
    g = place(g, 'c1', { fromMemberId: 'a', toMemberId: 'b' });
    g = patchItem(g, ROOT, 'c1', { color: '#ef4444', dashed: true, arrow: 'both' });
    const edge = readItems(g, ROOT).filter(isConnector)[0];
    expect(edge.extra.color).toBe('#ef4444');
    expect(edge.extra.dashed).toBe(true);
    expect(edge.extra.arrow).toBe('both');
    // endpoints untouched by styling
    expect(edge.extra.fromMemberId).toBe('a');
    expect(edge.extra.toMemberId).toBe('b');
  });

  it('routing a connector = patchItem({routing}) → it persists on the edge, endpoints untouched', () => {
    let g = emptyGraph();
    g = place(g, 'a');
    g = place(g, 'b');
    g = place(g, 'c1', { fromMemberId: 'a', toMemberId: 'b' });
    g = patchItem(g, ROOT, 'c1', { routing: 'elbow' });
    let edge = readItems(g, ROOT).filter(isConnector)[0];
    expect(edge.extra.routing).toBe('elbow');
    expect(edge.extra.fromMemberId).toBe('a'); // endpoints untouched by routing
    expect(edge.extra.toMemberId).toBe('b');
    // Cycle on to curved, then back to straight — every value round-trips as DATA.
    g = patchItem(g, ROOT, 'c1', { routing: 'curved' });
    expect(readItems(g, ROOT).filter(isConnector)[0].extra.routing).toBe('curved');
    g = patchItem(g, ROOT, 'c1', { routing: 'straight' });
    expect(readItems(g, ROOT).filter(isConnector)[0].extra.routing).toBe('straight');
  });

  it('a node carrying only one ref is NOT mistaken for an edge (both refs required)', () => {
    let g = emptyGraph();
    g = placeItem(g, ROOT, { memberId: 'half', nodeRef: itemRef('b1', 'half'), kind: 'note', x: 0, y: 0, extra: { fromMemberId: 'a' } });
    const items = readItems(g, ROOT);
    expect(items.filter(isConnector).length).toBe(0);
  });
});
