// packages/group/do-work/branch-toggle-states.test.ts
//
// Proof for #163 `branchToggleStates` — the per-node caret state driving the on-node
// collapse toggle. A node with a connector-subtree gets an entry (collapsed iff no
// descendant is visible; hiddenCount = # hidden descendants); a leaf gets none (no caret).

import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, readItems } from '../read-data/group-board-model';
import { branchToggleStates, setBranchHidden } from './batch-actions';

const B = boardRootRef('mm');
function note(g: ReturnType<typeof emptyGraph>, id: string) {
  return placeItem(g, B, { memberId: id, nodeRef: itemRef('mm', `n-${id}`), kind: 'note', x: 0, y: 0, w: 200, h: 100, text: id });
}
function connect(g: ReturnType<typeof emptyGraph>, id: string, from: string, to: string) {
  return placeItem(g, B, { memberId: id, nodeRef: itemRef('mm', `c-${id}`), kind: 'connector', x: 0, y: 0, extra: { fromMemberId: from, toMemberId: to } });
}
const hidden = (g: ReturnType<typeof emptyGraph>) => new Set(readItems(g, B).filter((i) => i.extra?.hidden === true).map((i) => i.memberId));

function tree() {
  // root → a → gc ; root → b
  let g = note(emptyGraph(), 'root');
  for (const n of ['a', 'b', 'gc']) g = note(g, n);
  g = connect(g, 'c1', 'root', 'a');
  g = connect(g, 'c2', 'root', 'b');
  g = connect(g, 'c3', 'a', 'gc');
  return g;
}

describe('branchToggleStates — on-node caret state', () => {
  it('a node WITH a subtree gets an entry; a leaf does NOT', () => {
    const g = tree();
    const states = branchToggleStates(readItems(g, B), new Set());
    expect(states.has('root')).toBe(true); // has a,b,gc
    expect(states.has('a')).toBe(true); // has gc
    expect(states.has('gc')).toBe(false); // leaf → no caret
    expect(states.has('b')).toBe(false); // leaf → no caret
  });

  it('all-visible subtree is NOT collapsed and has hiddenCount 0', () => {
    const states = branchToggleStates(readItems(tree(), B), new Set());
    expect(states.get('root')).toEqual({ collapsed: false, hiddenCount: 0 });
  });

  it('after collapsing root, root reads collapsed with the full hidden count', () => {
    const collapsed = setBranchHidden(tree(), B, 'root', true);
    const states = branchToggleStates(readItems(collapsed, B), hidden(collapsed));
    // root's 3 descendants (a,b,gc) are all hidden → collapsed, count 3.
    expect(states.get('root')).toEqual({ collapsed: true, hiddenCount: 3 });
    // 'a' no longer appears — it is itself hidden, so it is not rendered and carries no caret...
    // but branchToggleStates is shape-only (it still has gc as a descendant). It reports a's
    // own subtree state: gc is hidden → a is collapsed with count 1.
    expect(states.get('a')).toEqual({ collapsed: true, hiddenCount: 1 });
  });

  it('a PARTIALLY collapsed branch (some visible) is NOT collapsed', () => {
    // Hide only the deep grandchild; root still has visible children a,b.
    const g = setBranchHidden(tree(), B, 'a', true); // hides gc
    const states = branchToggleStates(readItems(g, B), hidden(g));
    expect(states.get('root')).toEqual({ collapsed: false, hiddenCount: 1 }); // gc hidden, a/b visible
    expect(states.get('a')).toEqual({ collapsed: true, hiddenCount: 1 }); // a's only desc gc is hidden
  });

  it('no connectors → empty map (no carets anywhere)', () => {
    let g = note(emptyGraph(), 'x');
    g = note(g, 'y');
    expect(branchToggleStates(readItems(g, B), new Set()).size).toBe(0);
  });
});
