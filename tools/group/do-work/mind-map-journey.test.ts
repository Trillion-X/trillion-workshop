// packages/group/do-work/mind-map-journey.test.ts
//
// Composed-critical-path proof for the REAL mind-map user journey: #159 connector
// quick-create (`connectNewNote` — the pure transform the drag-off-an-item gesture
// commits) BUILDS the graph, then #161 `arrangeMindMap` TIDIES it. The two are
// individually green (connect-new-note.test, mind-map-layout.test); THIS guards their
// COMPOSITION (L062 — built ≠ wired) at the model level so a future change to either
// can't silently break the journey the Playwright probe exercises live. No DOM, no
// gesture shell — just the same two pure functions the panel calls, in the same order.

import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, readItems, connectNewNote } from '../read-data/group-board-model';
import { arrangeMindMap } from './batch-actions';

const BOARD_ID = 'journey';
const B = boardRootRef(BOARD_ID);

/** Drive `connectNewNote` exactly as the gesture shell does: fresh injected ids, one
 *  commit. Returns the new note's member id so the next call can branch off it. */
let seq = 0;
function quickCreate(graph: ReturnType<typeof emptyGraph>, fromMemberId: string, x: number, y: number) {
  seq += 1;
  const { graph: next, noteMemberId } = connectNewNote(graph, B, {
    boardId: BOARD_ID,
    fromMemberId,
    x,
    y,
    noteMemberId: `note-${seq}`,
    noteItemId: `ni-${seq}`,
    connectorMemberId: `conn-${seq}`,
    connectorItemId: `ci-${seq}`,
  });
  return { graph: next, noteMemberId };
}

describe('mind-map journey — #159 connectNewNote builds, #161 arrangeMindMap tidies', () => {
  it('a quick-create tree reflows into a tidy 3-column hierarchy', () => {
    // Root note in the centre. Uniform 220×160 (the same default size connectNewNote
    // gives every quick-created child) so every column advances by the same pitch.
    let g = placeItem(emptyGraph(), B, { memberId: 'root', nodeRef: itemRef(BOARD_ID, 'i-root'), kind: 'note', x: 500, y: 500, w: 220, h: 160, text: 'root' });

    // Build the graph the way the user drags: root→A, root→B (messy, overlapping spots),
    // then A→grandchild — a real 2-level mind map made ONLY through the gesture transform.
    const a = quickCreate(g, 'root', 240, 120); g = a.graph;
    const b = quickCreate(g, 'root', 300, 160); g = b.graph;
    const gc = quickCreate(g, a.noteMemberId, 80, 900); g = gc.graph;

    // Sanity: the gesture produced 3 notes + 3 connectors (4 notes total, 3 edges).
    const built = readItems(g, B);
    const notes = built.filter((i) => typeof i.extra?.fromMemberId !== 'string');
    const conns = built.filter((i) => typeof i.extra?.fromMemberId === 'string');
    expect(notes).toHaveLength(4);
    expect(conns).toHaveLength(3);

    // Now TIDY the whole thing (every node selected).
    const nodeIds = notes.map((n) => n.memberId);
    const out = arrangeMindMap(g, B, nodeIds, { colGap: 100, rowGap: 40 });
    const by = Object.fromEntries(readItems(out, B).map((i) => [i.memberId, i]));

    // Three columns: root (0) < A == B (1) < grandchild (2).
    const rootX = by.root.x;
    const aX = by[a.noteMemberId].x;
    const bX = by[b.noteMemberId].x;
    const gcX = by[gc.noteMemberId].x;
    expect(aX).toBe(bX); // A and B share the child column
    expect(aX).toBeGreaterThan(rootX); // children right of root
    expect(gcX).toBeGreaterThan(aX); // grandchild right of its parent A
    // Exact column math: each column = previous + 220 (uniform max width) + 100 (colGap).
    expect(aX - rootX).toBe(320);
    expect(gcX - aX).toBe(320);

    // A and B are stacked (distinct rows), and the connectors were never repositioned
    // (they re-route from endpoints — still 3 of them, untouched extra refs).
    expect(by[a.noteMemberId].y).not.toBe(by[b.noteMemberId].y);
    const connsAfter = readItems(out, B).filter((i) => typeof i.extra?.fromMemberId === 'string');
    expect(connsAfter).toHaveLength(3);
    expect(connsAfter.every((c) => c.extra.fromMemberId && c.extra.toMemberId)).toBe(true);
  });

  it('re-tidying an already-tidy tree is idempotent (stable positions)', () => {
    let g = placeItem(emptyGraph(), B, { memberId: 'root', nodeRef: itemRef(BOARD_ID, 'i-root'), kind: 'note', x: 0, y: 0, w: 200, h: 100, text: 'root' });
    const a = quickCreate(g, 'root', 400, 50); g = a.graph;
    const b = quickCreate(g, 'root', 420, 300); g = b.graph;
    const ids = readItems(g, B).filter((i) => typeof i.extra?.fromMemberId !== 'string').map((i) => i.memberId);

    const once = arrangeMindMap(g, B, ids, { colGap: 80, rowGap: 30 });
    const twice = arrangeMindMap(once, B, ids, { colGap: 80, rowGap: 30 });
    const p1 = Object.fromEntries(readItems(once, B).map((i) => [i.memberId, `${i.x},${i.y}`]));
    const p2 = Object.fromEntries(readItems(twice, B).map((i) => [i.memberId, `${i.x},${i.y}`]));
    expect(p2).toEqual(p1); // second tidy is a no-op move — positions stable
  });
});
