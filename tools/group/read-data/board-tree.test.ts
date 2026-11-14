// packages/group/read-data/board-tree.test.ts
//
// Pure proof of the recursive board-tree reads. A board with a nested section
// exercises the recursion: flattenBoardTree yields the section THEN its children;
// findMemberRef/findParentRef resolve refs at depth; unknown ids → null. No DOM.

import { describe, expect, it } from 'vitest';
import { emptyGraph, groupKey, type GroupGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, groupItems, sectionRef, readItems } from './group-board-model';
import { flattenBoardTree, findMemberRef, findParentRef } from './board-tree';

const BOARD = 'vision-board';
const root = boardRootRef(BOARD);
const s1 = sectionRef(BOARD, 's1');

/** A board: top-level note `top`, plus a section `sec` (nodeRef s1) wrapping m1+m2. */
function nested() {
  let g = emptyGraph();
  g = placeItem(g, root, { memberId: 'top', nodeRef: itemRef(BOARD, 'i-top'), kind: 'note', x: 0, y: 0 });
  g = placeItem(g, root, { memberId: 'm1', nodeRef: itemRef(BOARD, 'i-m1'), kind: 'note', x: 10, y: 10 });
  g = placeItem(g, root, { memberId: 'm2', nodeRef: itemRef(BOARD, 'i-m2'), kind: 'note', x: 20, y: 20 });
  g = groupItems(g, root, ['m1', 'm2'], { sectionNodeRef: s1, wrapperMemberId: 'sec', x: 5, y: 5, text: 'Goals' });
  return g;
}

describe('flattenBoardTree — section then its children, world-space', () => {
  it('emits root items and recurses each section (section stays in the list)', () => {
    const flat = flattenBoardTree(nested(), root).map((i) => i.memberId);
    // top + the section, then the section's two children flattened in.
    expect(flat).toContain('top');
    expect(flat).toContain('sec');
    expect(flat).toContain('m1');
    expect(flat).toContain('m2');
    // The section appears BEFORE its children (parent pushed, then recursion).
    expect(flat.indexOf('sec')).toBeLessThan(flat.indexOf('m1'));
    expect(flat).toHaveLength(4);
  });

  it('a flat board (no sections) returns its items unchanged', () => {
    const g = placeItem(emptyGraph(), root, { memberId: 'a', nodeRef: itemRef(BOARD, 'i-a'), kind: 'note', x: 0, y: 0 });
    expect(flattenBoardTree(g, root).map((i) => i.memberId)).toEqual(['a']);
  });
});

describe('findMemberRef — the OWN ref of a member at any depth', () => {
  it('a top-level member resolves to its own nodeRef', () => {
    const g = nested();
    const top = readItems(g, root).find((i) => i.memberId === 'top')!;
    expect(findMemberRef(g, root, 'top')).toEqual(top.nodeRef);
  });

  it('a nested child resolves by recursing into the section', () => {
    const g = nested();
    const m1 = readItems(g, s1).find((i) => i.memberId === 'm1')!;
    expect(findMemberRef(g, root, 'm1')).toEqual(m1.nodeRef);
  });

  it('the section member resolves to its group ref (parent of its children)', () => {
    const g = nested();
    const sec = readItems(g, root).find((i) => i.memberId === 'sec')!;
    expect(findMemberRef(g, root, 'sec')).toEqual(sec.nodeRef);
  });

  it('an unknown id → null', () => {
    expect(findMemberRef(nested(), root, 'nope')).toBeNull();
  });
});

describe('findParentRef — the GROUP that contains a member', () => {
  it('a top-level member → the root ref', () => {
    expect(findParentRef(nested(), root, 'top')).toEqual(root);
    expect(findParentRef(nested(), root, 'sec')).toEqual(root);
  });

  it('a nested child → the section ref', () => {
    expect(findParentRef(nested(), root, 'm1')).toEqual(s1);
    expect(findParentRef(nested(), root, 'm2')).toEqual(s1);
  });

  it('an unknown id → null', () => {
    expect(findParentRef(nested(), root, 'nope')).toBeNull();
  });
});

describe('cycle-safety — a CORRUPTED persisted graph with cyclic section nesting must not hang (cont.98 batch-10)', () => {
  // store.load() hydrates graph.groups DIRECTLY from records (foldGroupRecords) — it does NOT run the
  // write-path cycle guard (nestGroup/reaches), so a corrupted/hand-crafted persisted graph can carry a
  // CYCLE (section s1 contains a member whose nodeRef points back at the ROOT group). The guarded API
  // (placeItem/groupItems) can't build that, so we inject it directly the way a bad record would fold.
  function cyclic(): GroupGraph {
    const g = nested();
    const s1key = groupKey(s1);
    const s1group = g.groups[s1key];
    return {
      ...g,
      groups: {
        ...g.groups,
        [s1key]: {
          ...s1group,
          memberOrder: [...s1group.memberOrder, 'loop'],
          // nodeRef === root → root IS a group → this member reads as a SECTION → old code descended
          // into root → sec → s1 → loop → root → ... forever. The seen-guard stops the re-descent.
          members: { ...s1group.members, loop: { memberId: 'loop', nodeRef: root } },
        },
      },
    };
  }

  it('flattenBoardTree terminates on a cyclic graph (never re-descends a seen group)', () => {
    const flat = flattenBoardTree(cyclic(), root).map((i) => i.memberId);
    // Every real item is present exactly once; the cyclic 'loop' member is emitted but NOT re-expanded.
    expect(flat).toContain('top');
    expect(flat).toContain('sec');
    expect(flat).toContain('m1');
    expect(flat).toContain('loop');
    // The root group is visited once — 'top'/'sec' appear a single time, not unboundedly.
    expect(flat.filter((id) => id === 'top')).toHaveLength(1);
    expect(flat.filter((id) => id === 'sec')).toHaveLength(1);
  }, 1500); // FAILS (times out) rather than hanging the run if the seen-guard regresses

  it('findMemberRef terminates on a cyclic graph — unknown id → null, known nested id still resolves', () => {
    expect(findMemberRef(cyclic(), root, 'nope')).toBeNull(); // full walk, no infinite recursion
    const m1 = readItems(cyclic(), s1).find((i) => i.memberId === 'm1')!;
    expect(findMemberRef(cyclic(), root, 'm1')).toEqual(m1.nodeRef);
  }, 1500);

  it('findParentRef terminates on a cyclic graph — unknown id → null', () => {
    expect(findParentRef(cyclic(), root, 'nope')).toBeNull();
    expect(findParentRef(cyclic(), root, 'm1')).toEqual(s1); // nested child still resolves to its section
  }, 1500);

  // A DEEP LINEAR chain of DISTINCT nested sections: the `seen` set never fires (no repeated key), so
  // ONLY the depth cap prevents a stack overflow on export/reorder/SHARE (cont.98 batch-42).
  function deepChain(depth: number): GroupGraph {
    const template = nested().groups[groupKey(s1)]; // a real group's shape to clone
    const refAt = (i: number) => (i < 0 ? root : sectionRef(BOARD, `s${i}`));
    const groups: Record<string, typeof template> = {};
    for (let i = -1; i < depth; i++) {
      const childId = `sec${i + 1}`;
      groups[groupKey(refAt(i))] = {
        ...template,
        memberOrder: [childId],
        members: { [childId]: { memberId: childId, nodeRef: refAt(i + 1), kind: 'section', x: 0, y: 0 } },
      } as typeof template;
    }
    groups[groupKey(refAt(depth))] = { ...template, memberOrder: [], members: {} } as typeof template;
    return { ...emptyGraph(), groups } as unknown as GroupGraph;
  }

  it('red-team (cont.98 batch-42): a 1100-deep DISTINCT-section chain never stack-overflows (depth cap, not just the cycle guard)', () => {
    const g = deepChain(1100); // > MAX_TREE_DEPTH (1000)
    let flat: string[] = [];
    expect(() => { flat = flattenBoardTree(g, root).map((i) => i.memberId); }).not.toThrow();
    expect(flat).toContain('sec0');           // shallow sections are walked
    expect(flat).not.toContain('sec1100');    // the ultra-deep section (past the cap) is dropped, not crashed
    // findMemberRef/findParentRef over the same adversarial graph also terminate without overflow
    expect(() => findMemberRef(g, root, 'nope')).not.toThrow();
    expect(findMemberRef(g, root, 'sec0')).not.toBeNull(); // a shallow member still resolves
  }, 5000);
});
