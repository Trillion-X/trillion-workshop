// packages/group/do-work/mind-map-topology.test.ts
//
// Proof for #164 keyboard mind-mapping topology reads: `parentViaConnectors` (the parent
// an Enter-sibling attaches under) and `directChildCount` (the row offset that stacks each
// Tab-child below the previous one). Both shape-based (itemIsConnector), zero kind literals.

import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, readItems } from '../read-data/group-board-model';
import { parentViaConnectors, directChildCount } from './batch-actions';

const B = boardRootRef('mm');
function note(g: ReturnType<typeof emptyGraph>, id: string) {
  return placeItem(g, B, { memberId: id, nodeRef: itemRef('mm', `n-${id}`), kind: 'note', x: 0, y: 0, w: 200, h: 100, text: id });
}
function connect(g: ReturnType<typeof emptyGraph>, id: string, from: string, to: string) {
  return placeItem(g, B, { memberId: id, nodeRef: itemRef('mm', `c-${id}`), kind: 'connector', x: 0, y: 0, extra: { fromMemberId: from, toMemberId: to } });
}

function tree() {
  // root → a → gc ; root → b
  let g = note(emptyGraph(), 'root');
  for (const n of ['a', 'b', 'gc']) g = note(g, n);
  g = connect(g, 'c1', 'root', 'a');
  g = connect(g, 'c2', 'root', 'b');
  g = connect(g, 'c3', 'a', 'gc');
  return g;
}

describe('parentViaConnectors — find the node to attach a sibling under', () => {
  it('returns the parent of a child node', () => {
    const items = readItems(tree(), B);
    expect(parentViaConnectors(items, 'a')).toBe('root');
    expect(parentViaConnectors(items, 'b')).toBe('root');
    expect(parentViaConnectors(items, 'gc')).toBe('a');
  });

  it('returns undefined for a root (no inbound connector → no sibling)', () => {
    expect(parentViaConnectors(readItems(tree(), B), 'root')).toBeUndefined();
  });

  it('returns undefined when there are no connectors at all', () => {
    let g = note(emptyGraph(), 'x');
    g = note(g, 'y');
    expect(parentViaConnectors(readItems(g, B), 'x')).toBeUndefined();
  });

  it('returns the FIRST parent on a DAG (deterministic)', () => {
    // root → a, alt → a (a has two inbound). First connector in order wins.
    let g = note(emptyGraph(), 'root');
    g = note(g, 'alt');
    g = note(g, 'a');
    g = connect(g, 'c1', 'root', 'a');
    g = connect(g, 'c2', 'alt', 'a');
    expect(parentViaConnectors(readItems(g, B), 'a')).toBe('root');
  });
});

describe('directChildCount — the row offset that stacks Tab-children', () => {
  it('counts only DIRECT connector-children, not transitive descendants', () => {
    const items = readItems(tree(), B);
    expect(directChildCount(items, 'root')).toBe(2); // a, b (NOT gc)
    expect(directChildCount(items, 'a')).toBe(1); // gc
    expect(directChildCount(items, 'gc')).toBe(0); // leaf
    expect(directChildCount(items, 'b')).toBe(0); // leaf
  });

  it('is 0 for a node with no connectors', () => {
    let g = note(emptyGraph(), 'x');
    g = note(g, 'y');
    expect(directChildCount(readItems(g, B), 'x')).toBe(0);
  });

  it('grows by one per added child (the stacking invariant)', () => {
    let g = note(emptyGraph(), 'root');
    g = note(g, 'k1');
    g = connect(g, 'c1', 'root', 'k1');
    expect(directChildCount(readItems(g, B), 'root')).toBe(1);
    g = note(g, 'k2');
    g = connect(g, 'c2', 'root', 'k2');
    expect(directChildCount(readItems(g, B), 'root')).toBe(2);
  });
});
