// packages/group/do-work/branch-collapse.test.ts
//
// Proof for #162 mind-map branch collapse/expand — the third leg of the mind-map triad
// (#159 build → #161 tidy → #162 focus). Two layers:
//   1. `descendantsViaConnectors` — the pure connector-topology traversal (every node
//      reachable from a root by following from→to edges, root excluded, cycle-safe).
//   2. `setBranchHidden` — flips `extra.hidden` on that subtree via the #149 visibility
//      primitive (collapse=true, expand=false), leaving the root + siblings + unrelated
//      nodes untouched.

import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, readItems } from '../read-data/group-board-model';
import { descendantsViaConnectors, setBranchHidden } from './batch-actions';

const B = boardRootRef('mm');

function note(graph: ReturnType<typeof emptyGraph>, id: string) {
  return placeItem(graph, B, { memberId: id, nodeRef: itemRef('mm', `n-${id}`), kind: 'note', x: 0, y: 0, w: 200, h: 100, text: id });
}
function connect(graph: ReturnType<typeof emptyGraph>, id: string, from: string, to: string) {
  return placeItem(graph, B, { memberId: id, nodeRef: itemRef('mm', `c-${id}`), kind: 'connector', x: 0, y: 0, extra: { fromMemberId: from, toMemberId: to } });
}
const hiddenIds = (graph: ReturnType<typeof emptyGraph>) =>
  readItems(graph, B).filter((i) => i.extra?.hidden === true).map((i) => i.memberId).sort();

describe('descendantsViaConnectors — connector-topology traversal', () => {
  const items = (g: ReturnType<typeof emptyGraph>) => readItems(g, B);

  it('collects the whole subtree (multi-level), excluding the root', () => {
    // root → a → grandchild ; root → b
    let g = note(emptyGraph(), 'root');
    for (const n of ['a', 'b', 'gc']) g = note(g, n);
    g = connect(g, 'c1', 'root', 'a');
    g = connect(g, 'c2', 'root', 'b');
    g = connect(g, 'c3', 'a', 'gc');
    expect(descendantsViaConnectors(items(g), 'root').sort()).toEqual(['a', 'b', 'gc']);
    // From an interior node: only ITS subtree.
    expect(descendantsViaConnectors(items(g), 'a')).toEqual(['gc']);
  });

  it('a leaf (no connector-children) has no descendants', () => {
    let g = note(emptyGraph(), 'root');
    g = note(g, 'a');
    g = connect(g, 'c1', 'root', 'a');
    expect(descendantsViaConnectors(items(g), 'a')).toEqual([]);
  });

  it('is cycle-safe — a back-edge does not loop and each node appears once', () => {
    // root → a → b → a (cycle)
    let g = note(emptyGraph(), 'root');
    for (const n of ['a', 'b']) g = note(g, n);
    g = connect(g, 'c1', 'root', 'a');
    g = connect(g, 'c2', 'a', 'b');
    g = connect(g, 'c3', 'b', 'a');
    expect(descendantsViaConnectors(items(g), 'root').sort()).toEqual(['a', 'b']);
  });

  it('ignores a disconnected node (not reachable from the root)', () => {
    let g = note(emptyGraph(), 'root');
    for (const n of ['a', 'island']) g = note(g, n);
    g = connect(g, 'c1', 'root', 'a');
    expect(descendantsViaConnectors(items(g), 'root')).toEqual(['a']);
  });
});

describe('setBranchHidden — collapse/expand via the #149 visibility primitive', () => {
  function tree() {
    // root → a → gc ; root → b ; plus an unrelated island note.
    let g = note(emptyGraph(), 'root');
    for (const n of ['a', 'b', 'gc', 'island']) g = note(g, n);
    g = connect(g, 'c1', 'root', 'a');
    g = connect(g, 'c2', 'root', 'b');
    g = connect(g, 'c3', 'a', 'gc');
    return g;
  }

  it('collapse hides exactly the subtree — root, siblings of the tree, and island stay visible', () => {
    const collapsed = setBranchHidden(tree(), B, 'root', true);
    expect(hiddenIds(collapsed)).toEqual(['a', 'b', 'gc']); // every descendant hidden
    const by = Object.fromEntries(readItems(collapsed, B).map((i) => [i.memberId, i]));
    expect(by.root.extra?.hidden).not.toBe(true); // root carries the collapsed branch
    expect(by.island.extra?.hidden).not.toBe(true); // unrelated node untouched
  });

  it('collapsing an interior node hides only ITS subtree', () => {
    const collapsed = setBranchHidden(tree(), B, 'a', true);
    expect(hiddenIds(collapsed)).toEqual(['gc']); // only a's child
  });

  it('expand restores the subtree (round-trip identity on hidden flags)', () => {
    const collapsed = setBranchHidden(tree(), B, 'root', true);
    const expanded = setBranchHidden(collapsed, B, 'root', false);
    expect(hiddenIds(expanded)).toEqual([]); // everything visible again
  });

  it('is a no-op on a leaf (no connector-children)', () => {
    const g = tree();
    const out = setBranchHidden(g, B, 'gc', true);
    expect(hiddenIds(out)).toEqual([]); // nothing to collapse
  });
});
