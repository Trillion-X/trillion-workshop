// packages/group/do-work/rainbow-mindmap-journey.test.ts
//
// Composed-critical-path proof for the rainbow mind-map line (#159 → #165 → #166, the same
// composition #167's live-inherit reuses). Drives the REAL transforms end-to-end at the
// graph level: build a 2-branch tree with `connectNewNote`, colour it with
// `branchColorAssignments`, then derive the connector colours with `connectorBranchColors`
// — and asserts the full rainbow contract holds (branches distinct, descendants + their
// connectors inherit, root + its inbound nothing-to-inherit stay neutral). This is the
// L062 "built ≠ wired" guard: if any link in the chain drifts, this fails deterministically
// without needing the live studio.

import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, readItems, connectNewNote } from '../read-data/group-board-model';
import { branchColorAssignments, connectorBranchColors } from './batch-actions';

const B = boardRootRef('mm');
const PAL = ['#aaa', '#bbb', '#ccc'] as const;

// Mirror the panel's addMindMapChild id-minting with fixed ids (pure + deterministic).
let seq = 0;
const id = (p: string) => `${p}-${seq++}`;
function child(g: ReturnType<typeof emptyGraph>, fromMemberId: string, x: number, y: number) {
  const noteMemberId = id('m');
  const connectorMemberId = id('c');
  const { graph } = connectNewNote(g, B, {
    boardId: 'mm', fromMemberId, x, y,
    noteMemberId, noteItemId: id('i'), connectorMemberId, connectorItemId: id('i'),
  });
  return { graph, noteMemberId, connectorMemberId };
}

describe('rainbow mind-map journey — connectNewNote → branchColorAssignments → connectorBranchColors', () => {
  it('builds a 2-branch tree and colours nodes + connectors consistently per branch', () => {
    seq = 0;
    // root (placed plainly) → A → A1 ; root → B  — all via the REAL connectNewNote.
    let g = placeItem(emptyGraph(), B, { memberId: 'root', nodeRef: itemRef('mm', 'n-root'), kind: 'note', x: 0, y: 0, w: 220, h: 160, text: 'root' });
    const a = child(g, 'root', 300, 0); g = a.graph;
    const bb = child(g, 'root', 300, 200); g = bb.graph;
    const a1 = child(g, a.noteMemberId, 600, 0); g = a1.graph;

    const items = readItems(g, B);
    const nodeColors = branchColorAssignments(items, PAL);
    const connColors = connectorBranchColors(items, nodeColors);

    // Two distinct top-level branches.
    expect(nodeColors.get(a.noteMemberId)).toBe('#aaa');
    expect(nodeColors.get(bb.noteMemberId)).toBe('#bbb');
    // Descendant inherits its branch colour.
    expect(nodeColors.get(a1.noteMemberId)).toBe('#aaa');
    // Root stays neutral.
    expect(nodeColors.has('root')).toBe(false);

    // Each connector matches the colour of the node it enters (whole branch = one colour).
    expect(connColors.get(a.connectorMemberId)).toBe('#aaa'); // root→A
    expect(connColors.get(bb.connectorMemberId)).toBe('#bbb'); // root→B
    expect(connColors.get(a1.connectorMemberId)).toBe('#aaa'); // A→A1

    // Invariant: every connector's colour equals its `to` node's colour (no orphan tint).
    for (const it of items) {
      const to = it.extra?.toMemberId;
      if (typeof to === 'string' && nodeColors.has(to)) {
        expect(connColors.get(it.memberId)).toBe(nodeColors.get(to));
      }
    }
  });

  it("a single chain is one colour through every node and connector", () => {
    seq = 100;
    let g = placeItem(emptyGraph(), B, { memberId: 'r', nodeRef: itemRef('mm', 'n-r'), kind: 'note', x: 0, y: 0, w: 220, h: 160, text: 'r' });
    const c1 = child(g, 'r', 300, 0); g = c1.graph;
    const c2 = child(g, c1.noteMemberId, 600, 0); g = c2.graph;
    const c3 = child(g, c2.noteMemberId, 900, 0); g = c3.graph;

    const items = readItems(g, B);
    const nodeColors = branchColorAssignments(items, PAL);
    const connColors = connectorBranchColors(items, nodeColors);
    // One branch off the root → every node + connector in the chain is palette[0].
    for (const m of [c1.noteMemberId, c2.noteMemberId, c3.noteMemberId]) expect(nodeColors.get(m)).toBe('#aaa');
    for (const c of [c1.connectorMemberId, c2.connectorMemberId, c3.connectorMemberId]) expect(connColors.get(c)).toBe('#aaa');
  });
});
