// Proof for boardToCapsuleSource — the SHARE twin of the export flatten. It must gather a board's
// WHOLE tree (root + every nested section's descendants) into a flat, world-space source, tagging
// each descendant with its enclosing section id so buildShareCapsule's section-closure carries the
// subtree. Before this, a share dropped every nested note (Codex share-audit #2). Pure, no DOM.

import { describe, expect, it } from 'vitest';
import { emptyGraph, groupKey, type GroupGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, placeSection, sectionRef } from './group-board-model';
import { boardToCapsuleSource } from './board-to-capsule-source';

const BOARD = 'B';
const root = boardRootRef(BOARD);

// Top note + a Section {child1, child2, Inner{grand}} — a two-deep nested tree with world coords.
function build() {
  let g = emptyGraph();
  g = placeItem(g, root, { memberId: 'n1', nodeRef: itemRef(BOARD, 'i1'), kind: 'note', x: 0, y: 0, w: 100, h: 60, text: 'top1' });
  g = placeSection(g, root, { memberId: 'sec', sectionNodeRef: sectionRef(BOARD, 's'), x: 200, y: 0, w: 400, h: 300, text: 'Section' });
  g = placeItem(g, sectionRef(BOARD, 's'), { memberId: 'c1', nodeRef: itemRef(BOARD, 'ic1'), kind: 'note', x: 220, y: 40, w: 100, h: 60, text: 'child1' });
  g = placeItem(g, sectionRef(BOARD, 's'), { memberId: 'c2', nodeRef: itemRef(BOARD, 'ic2'), kind: 'note', x: 340, y: 40, w: 100, h: 60, text: 'child2' });
  g = placeSection(g, sectionRef(BOARD, 's'), { memberId: 'sec2', sectionNodeRef: sectionRef(BOARD, 's2'), x: 220, y: 140, w: 200, h: 120, text: 'Inner' });
  g = placeItem(g, sectionRef(BOARD, 's2'), { memberId: 'g1', nodeRef: itemRef(BOARD, 'ig1'), kind: 'note', x: 240, y: 180, w: 80, h: 40, text: 'grand' });
  return g;
}

describe('boardToCapsuleSource — flatten the whole board tree into the share source', () => {
  const src = boardToCapsuleSource(build(), root);
  const by = (id: string) => src.find((i) => i.memberId === id)!;

  it('includes EVERY item across the whole tree (root + all nested descendants)', () => {
    expect(src.map((i) => i.memberId).sort()).toEqual(['c1', 'c2', 'g1', 'n1', 'sec', 'sec2']);
  });

  it('marks a section with isSection + its real childCount (folder badge)', () => {
    expect(by('sec').isSection).toBe(true);
    expect(by('sec').childCount).toBe(3); // c1, c2, sec2
    expect(by('sec2').isSection).toBe(true);
    expect(by('sec2').childCount).toBe(1); // g1
  });

  it('tags each descendant with its ENCLOSING section id (root items have none)', () => {
    expect(by('n1').sectionId).toBeUndefined();
    expect(by('sec').sectionId).toBeUndefined();
    expect(by('c1').sectionId).toBe('sec');
    expect(by('c2').sectionId).toBe('sec');
    expect(by('sec2').sectionId).toBe('sec'); // the inner section sits inside the outer
    expect(by('g1').sectionId).toBe('sec2'); // grandchild sits inside the inner section
  });

  it('preserves WORLD coordinates (a flat list renders at the right positions)', () => {
    expect({ x: by('c1').x, y: by('c1').y }).toEqual({ x: 220, y: 40 });
    expect({ x: by('g1').x, y: by('g1').y }).toEqual({ x: 240, y: 180 });
  });

  it('non-section items carry no section metadata', () => {
    expect(by('n1').isSection).toBeUndefined();
    expect(by('n1').childCount).toBeUndefined();
  });
});

describe('cycle-safety — a CORRUPTED persisted graph with cyclic section nesting must not hang the share build (cont.98 batch-13)', () => {
  // The share flatten now reuses the SHARED cycle-safe walkTree (the export-flatten SSOT). Inject a
  // cycle a hostile/corrupted capsule could carry: the inner section 's2' contains a member whose
  // nodeRef points back at the outer section 's' (s -> s2 -> s). The guarded API can't build this,
  // so mutate graph.groups directly the way a bad foldGroupRecords hydration would.
  function cyclic(): GroupGraph {
    const g = build();
    const s2key = groupKey(sectionRef(BOARD, 's2'));
    const s2group = g.groups[s2key];
    return {
      ...g,
      groups: {
        ...g.groups,
        [s2key]: {
          ...s2group,
          memberOrder: [...s2group.memberOrder, 'loop'],
          members: { ...s2group.members, loop: { memberId: 'loop', nodeRef: sectionRef(BOARD, 's') } },
        },
      },
    };
  }

  it('boardToCapsuleSource terminates on a cyclic graph (never re-descends a seen section)', () => {
    const src = boardToCapsuleSource(cyclic(), root);
    const ids = src.map((i) => i.memberId);
    // every real item appears exactly once; the cyclic 'loop' member is emitted but NOT re-expanded.
    expect(ids).toContain('g1');
    expect(ids).toContain('loop');
    expect(ids.filter((id) => id === 'c1')).toHaveLength(1);
    expect(ids.filter((id) => id === 'g1')).toHaveLength(1);
  }, 1500); // times out (fails) rather than hanging the run if the shared seen-guard regresses
});
