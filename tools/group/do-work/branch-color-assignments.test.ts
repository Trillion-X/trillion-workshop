// packages/group/do-work/branch-color-assignments.test.ts
//
// Proof for #165 `branchColorAssignments` — rainbow branches. Each top-level branch of a
// mind-map tree (a direct child of a root + its whole subtree) gets a distinct palette
// colour; the root stays neutral (unassigned); the palette wraps; shape-based (no kind
// literal); a forest restarts the palette per tree.

import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, readItems } from '../read-data/group-board-model';
import { branchColorAssignments } from './batch-actions';

const B = boardRootRef('mm');
const PAL = ['#a', '#b', '#c'] as const;
function note(g: ReturnType<typeof emptyGraph>, id: string) {
  return placeItem(g, B, { memberId: id, nodeRef: itemRef('mm', `n-${id}`), kind: 'note', x: 0, y: 0, w: 200, h: 100, text: id });
}
function connect(g: ReturnType<typeof emptyGraph>, id: string, from: string, to: string) {
  return placeItem(g, B, { memberId: id, nodeRef: itemRef('mm', `c-${id}`), kind: 'connector', x: 0, y: 0, extra: { fromMemberId: from, toMemberId: to } });
}

function tree() {
  // root → A → A1 ; root → B  (two top-level branches, A has a descendant)
  let g = note(emptyGraph(), 'root');
  for (const n of ['A', 'A1', 'B']) g = note(g, n);
  g = connect(g, 'c1', 'root', 'A');
  g = connect(g, 'c2', 'root', 'B');
  g = connect(g, 'c3', 'A', 'A1');
  return g;
}

describe('branchColorAssignments — rainbow branches', () => {
  it('two top-level branches get two DISTINCT palette colours', () => {
    const m = branchColorAssignments(readItems(tree(), B), PAL);
    expect(m.get('A')).toBe('#a');
    expect(m.get('B')).toBe('#b');
    expect(m.get('A')).not.toBe(m.get('B'));
  });

  it("a branch's descendants INHERIT the branch colour", () => {
    const m = branchColorAssignments(readItems(tree(), B), PAL);
    expect(m.get('A1')).toBe('#a'); // A1 is under branch A
  });

  it('the ROOT stays neutral (unassigned)', () => {
    expect(branchColorAssignments(readItems(tree(), B), PAL).has('root')).toBe(false);
  });

  it('the palette WRAPS past its length (4th branch reuses the 1st colour)', () => {
    let g = note(emptyGraph(), 'root');
    for (const n of ['b0', 'b1', 'b2', 'b3']) g = note(g, n);
    g = connect(g, 'c0', 'root', 'b0');
    g = connect(g, 'c1', 'root', 'b1');
    g = connect(g, 'c2', 'root', 'b2');
    g = connect(g, 'c3', 'root', 'b3');
    const m = branchColorAssignments(readItems(g, B), PAL);
    expect(m.get('b0')).toBe('#a');
    expect(m.get('b1')).toBe('#b');
    expect(m.get('b2')).toBe('#c');
    expect(m.get('b3')).toBe('#a'); // wraps
  });

  it('a forest (two roots) restarts the palette per tree', () => {
    // r1 → x ;  r2 → y   — both first branches get palette[0]
    let g = note(emptyGraph(), 'r1');
    for (const n of ['x', 'r2', 'y']) g = note(g, n);
    g = connect(g, 'c1', 'r1', 'x');
    g = connect(g, 'c2', 'r2', 'y');
    const m = branchColorAssignments(readItems(g, B), PAL);
    expect(m.get('x')).toBe('#a');
    expect(m.get('y')).toBe('#a');
  });

  it('no connectors / empty palette → empty map', () => {
    let g = note(emptyGraph(), 'x');
    g = note(g, 'y');
    expect(branchColorAssignments(readItems(g, B), PAL).size).toBe(0);
    expect(branchColorAssignments(readItems(tree(), B), []).size).toBe(0);
  });
});
