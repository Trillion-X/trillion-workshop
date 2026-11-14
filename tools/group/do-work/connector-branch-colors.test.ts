// packages/group/do-work/connector-branch-colors.test.ts
//
// Proof for #166 `connectorBranchColors` — the connector half of rainbow branches. A
// connector takes the branch colour of the NODE it points into (`toMemberId`), so the whole
// branch (nodes + the lines linking them) reads as one colour. Composes the #165 node map.

import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, readItems } from '../read-data/group-board-model';
import { branchColorAssignments, connectorBranchColors } from './batch-actions';

const B = boardRootRef('mm');
const PAL = ['#a', '#b'] as const;
function note(g: ReturnType<typeof emptyGraph>, id: string) {
  return placeItem(g, B, { memberId: id, nodeRef: itemRef('mm', `n-${id}`), kind: 'note', x: 0, y: 0, w: 200, h: 100, text: id });
}
function connect(g: ReturnType<typeof emptyGraph>, id: string, from: string, to: string) {
  return placeItem(g, B, { memberId: id, nodeRef: itemRef('mm', `c-${id}`), kind: 'connector', x: 0, y: 0, extra: { fromMemberId: from, toMemberId: to } });
}

function tree() {
  // root → A → A1 ; root → B  (connectors c1=root→A, c2=root→B, c3=A→A1)
  let g = note(emptyGraph(), 'root');
  for (const n of ['A', 'A1', 'B']) g = note(g, n);
  g = connect(g, 'c1', 'root', 'A');
  g = connect(g, 'c2', 'root', 'B');
  g = connect(g, 'c3', 'A', 'A1');
  return g;
}

describe('connectorBranchColors — colour the branch lines', () => {
  it('a connector takes the colour of the NODE it points into', () => {
    const items = readItems(tree(), B);
    const nodeColors = branchColorAssignments(items, PAL); // A,A1 → #a ; B → #b
    const cc = connectorBranchColors(items, nodeColors);
    expect(cc.get('c1')).toBe('#a'); // root→A, A is #a
    expect(cc.get('c2')).toBe('#b'); // root→B, B is #b
    expect(cc.get('c3')).toBe('#a'); // A→A1, A1 is #a
  });

  it('the connector colour matches its `to` node exactly (branch-consistent)', () => {
    const items = readItems(tree(), B);
    const nodeColors = branchColorAssignments(items, PAL);
    const cc = connectorBranchColors(items, nodeColors);
    for (const it of items) {
      const to = it.extra?.toMemberId;
      if (typeof to === 'string' && nodeColors.has(to)) {
        expect(cc.get(it.memberId)).toBe(nodeColors.get(to));
      }
    }
  });

  it('a connector whose `to` node is NOT in the colour map is absent', () => {
    // Hand-built partial map: only A is coloured. c1(→A) colours; c2(→B) and c3(→A1) do not.
    const items = readItems(tree(), B);
    const partial = new Map([['A', '#a']]);
    const cc = connectorBranchColors(items, partial);
    expect(cc.get('c1')).toBe('#a'); // →A, A is in the map
    expect(cc.has('c2')).toBe(false); // →B, B absent from the map
    expect(cc.has('c3')).toBe(false); // →A1, A1 absent from the map
  });

  it('no connectors → empty map', () => {
    let g = note(emptyGraph(), 'p');
    g = note(g, 'q');
    const items = readItems(g, B);
    expect(connectorBranchColors(items, branchColorAssignments(items, PAL)).size).toBe(0);
  });

  it('empty node-colour map → empty (nothing to inherit)', () => {
    const items = readItems(tree(), B);
    expect(connectorBranchColors(items, new Map()).size).toBe(0);
  });
});
