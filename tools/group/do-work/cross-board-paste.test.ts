// packages/group/do-work/cross-board-paste.test.ts
//
// Integration proof for the CROSS-BOARD paste round-trip — the composed critical path
// the UI exercises (⌘C on board A → switch board → ⌘V on board B). The clipboard unit
// pieces are covered in board-clipboard.test.ts; THIS test wires them to the real board
// MODEL (`placeItem`/`readItems` on two distinct board graphs) to prove copied items
// genuinely MATERIALIZE on a different board — anchored at the paste origin, relative
// layout + text/kind preserved, and the SOURCE board left untouched. L062 (built ≠ wired):
// the singleton clipboard + clipboardToDrafts + placeItem are individually green; this
// guards their composition so a future change can't silently break cross-board paste.

import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, readItems } from '../read-data/group-board-model';
import { copyItemsToClipboard, clipboardToDrafts, planPaste, setBoardClipboard, getBoardClipboard } from './board-clipboard';
import { branchMemberIds } from './batch-actions';

const A = boardRootRef('board-A');
const B = boardRootRef('board-B');

/** Place the clipboard's drafts (anchored at originX/Y) onto a board graph — the exact
 *  map the panel's `placePasteDrafts` does (fresh ids per draft). */
function pasteOnto(graph: ReturnType<typeof emptyGraph>, boardId: string, boardRef = boardRootRef(boardId), originX = 0, originY = 0) {
  const clip = getBoardClipboard();
  if (!clip) return graph;
  let g = graph;
  let n = 0;
  for (const d of clipboardToDrafts(clip, originX, originY)) {
    g = placeItem(g, boardRef, {
      memberId: `paste-${boardId}-${n}`,
      nodeRef: itemRef(boardId, `pi-${n}`),
      kind: d.kind,
      x: d.x,
      y: d.y,
      w: d.w,
      h: d.h,
      text: d.text,
      src: d.src,
      extra: d.extra,
    });
    n += 1;
  }
  return g;
}

describe('cross-board paste — copy on board A, paste materializes on board B', () => {
  it('copied items land on a DIFFERENT board at the paste origin, relative layout + text preserved', () => {
    // Board A: two notes with a known relative offset (the 2nd is +120,+40 from the 1st).
    let ga = placeItem(emptyGraph(), A, { memberId: 'a1', nodeRef: itemRef('board-A', 'i1'), kind: 'note', x: 200, y: 200, text: 'Alpha' });
    ga = placeItem(ga, A, { memberId: 'a2', nodeRef: itemRef('board-A', 'i2'), kind: 'note', x: 320, y: 240, text: 'Beta' });

    // ⌘C: copy the selection into the cross-board singleton.
    const clip = copyItemsToClipboard(readItems(ga, A));
    expect(clip).not.toBeNull();
    setBoardClipboard(clip);

    // Switch to a FRESH board B (separate graph) and ⌘V at origin (1000, 500).
    const gb = pasteOnto(emptyGraph(), 'board-B', B, 1000, 500);
    const pasted = readItems(gb, B);

    // Two items materialized on board B.
    expect(pasted).toHaveLength(2);
    expect(pasted.map((i) => i.text).sort()).toEqual(['Alpha', 'Beta']);
    expect(pasted.every((i) => i.kind === 'note')).toBe(true);

    // Anchored at the paste origin with the SAME relative layout (the +120,+40 offset survives).
    const byText = Object.fromEntries(pasted.map((i) => [i.text, i]));
    expect(byText.Alpha.x).toBe(1000);
    expect(byText.Alpha.y).toBe(500);
    expect(byText.Beta.x - byText.Alpha.x).toBe(120);
    expect(byText.Beta.y - byText.Alpha.y).toBe(40);

    // The SOURCE board A is untouched — paste is additive on B, never mutates A.
    const srcAfter = readItems(ga, A);
    expect(srcAfter).toHaveLength(2);
    expect(srcAfter.map((i) => i.memberId).sort()).toEqual(['a1', 'a2']);
    expect(srcAfter.find((i) => i.memberId === 'a1')!.x).toBe(200); // unchanged origin
  });

  it('the singleton is the cross-board carrier — a copy survives the board "switch"', () => {
    const ga = placeItem(emptyGraph(), A, { memberId: 'a1', nodeRef: itemRef('board-A', 'i1'), kind: 'note', x: 0, y: 0, text: 'Carry' });
    setBoardClipboard(copyItemsToClipboard(readItems(ga, A)));
    // After "switching boards" (no re-copy), the singleton still holds the bundle.
    const carried = getBoardClipboard();
    expect(carried).not.toBeNull();
    expect(carried!.items).toHaveLength(1);
    expect(carried!.items[0].text).toBe('Carry');
    // And it pastes onto yet another board.
    const gb = pasteOnto(emptyGraph(), 'board-B', B, 50, 60);
    expect(readItems(gb, B).map((i) => i.text)).toEqual(['Carry']);
  });

  it('an empty selection copies nothing — paste onto another board is a no-op', () => {
    setBoardClipboard(copyItemsToClipboard([])); // null → clears the singleton
    expect(getBoardClipboard()).toBeNull();
    const gb = pasteOnto(emptyGraph(), 'board-B', B, 0, 0);
    expect(readItems(gb, B)).toHaveLength(0);
  });
});

// ── #188: graph-level proof that an internal connector survives copy→paste with its
//    endpoints re-anchored to the PASTED nodes (the real placePasteDrafts path via
//    planPaste). Guards #187 against regression at the composition level — the unit
//    tests in board-clipboard.test.ts prove planPaste on stub drafts; THIS proves it on
//    a real place/read graph, on a different board, with fresh ids.
/** Paste the clipboard onto a board via the REAL planPaste remap — the exact map the
 *  panel's placePasteDrafts does, minting fresh ids and re-anchoring connectors. */
function pasteWithPlan(graph: ReturnType<typeof emptyGraph>, boardId: string, boardRef: ReturnType<typeof boardRootRef>, originX: number, originY: number) {
  const clip = getBoardClipboard();
  if (!clip) return graph;
  let g = graph;
  let n = 0;
  const mint = () => `np-${boardId}-${n++}`;
  for (const p of planPaste(clipboardToDrafts(clip, originX, originY), mint)) {
    g = placeItem(g, boardRef, {
      memberId: p.memberId,
      nodeRef: itemRef(boardId, `pi-${p.memberId}`),
      kind: p.kind,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      text: p.text,
      src: p.src,
      extra: p.extra,
    });
  }
  return g;
}

describe('cross-board paste — internal connectors re-anchor to the pasted nodes (#188)', () => {
  it('a copied connector between two copied nodes joins the PASTED clones, not the originals', () => {
    // Board A: two notes joined by a connector (a1 → a2).
    let ga = placeItem(emptyGraph(), A, { memberId: 'a1', nodeRef: itemRef('board-A', 'i1'), kind: 'note', x: 0, y: 0, text: 'From' });
    ga = placeItem(ga, A, { memberId: 'a2', nodeRef: itemRef('board-A', 'i2'), kind: 'note', x: 200, y: 0, text: 'To' });
    ga = placeItem(ga, A, { memberId: 'c1', nodeRef: itemRef('board-A', 'ic'), kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a1', toMemberId: 'a2' } });

    setBoardClipboard(copyItemsToClipboard(readItems(ga, A)));
    const gb = pasteWithPlan(emptyGraph(), 'board-B', B, 1000, 500);
    const pasted = readItems(gb, B);

    const nodes = pasted.filter((i) => i.kind !== 'connector');
    const conns = pasted.filter((i) => i.kind === 'connector');
    expect(nodes).toHaveLength(2);
    expect(conns).toHaveLength(1);

    // The pasted connector's endpoints are the PASTED node ids — never the originals a1/a2.
    const nodeIds = new Set(nodes.map((n) => n.memberId));
    const from = conns[0].extra?.fromMemberId as string;
    const to = conns[0].extra?.toMemberId as string;
    expect(nodeIds.has(from)).toBe(true);
    expect(nodeIds.has(to)).toBe(true);
    expect([from, to]).not.toContain('a1');
    expect([from, to]).not.toContain('a2');

    // Board A untouched — its connector still joins the originals.
    const srcConn = readItems(ga, A).find((i) => i.kind === 'connector')!;
    expect([srcConn.extra?.fromMemberId, srcConn.extra?.toMemberId]).toEqual(['a1', 'a2']);
  });

  it('a connector whose other endpoint is NOT copied is dropped (no dangling ref pasted)', () => {
    let ga = placeItem(emptyGraph(), A, { memberId: 'a1', nodeRef: itemRef('board-A', 'i1'), kind: 'note', x: 0, y: 0, text: 'Lonely' });
    ga = placeItem(ga, A, { memberId: 'a2', nodeRef: itemRef('board-A', 'i2'), kind: 'note', x: 200, y: 0, text: 'Outsider' });
    ga = placeItem(ga, A, { memberId: 'c1', nodeRef: itemRef('board-A', 'ic'), kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'a1', toMemberId: 'a2' } });

    // Copy ONLY a1 + the connector (a2 left out) → the connector must be dropped.
    const onlyOne = readItems(ga, A).filter((i) => i.memberId === 'a1' || i.memberId === 'c1');
    setBoardClipboard(copyItemsToClipboard(onlyOne));
    const gb = pasteWithPlan(emptyGraph(), 'board-B', B, 0, 0);
    const pasted = readItems(gb, B);
    expect(pasted).toHaveLength(1);
    expect(pasted[0].kind).not.toBe('connector');
    expect(pasted[0].text).toBe('Lonely');
  });
});

// ── #192: emergent composition proof — SELECT BRANCH (#186) then DUPLICATE (#187) yields a
//    fully-connected clone of the subtree. Guards the flagship "grab a branch and copy it"
//    workflow: branchMemberIds picks the subtree, copyItemsToClipboard keeps only its
//    INTERNAL connectors, planPaste re-anchors them to the clones, and the parent link up to
//    the un-selected root is dropped (it would dangle). No single earlier test spans both
//    primitives on one graph.
describe('duplicate a selected branch keeps the subtree connected (#186 + #187 compose, #192)', () => {
  /** A mind-map:  root → mid → leaf, and root → sibling.  Branch of `mid` = {mid, leaf}. */
  function mindMap() {
    let g = placeItem(emptyGraph(), A, { memberId: 'root', nodeRef: itemRef('board-A', 'ir'), kind: 'note', x: 0, y: 0, text: 'Root' });
    g = placeItem(g, A, { memberId: 'mid', nodeRef: itemRef('board-A', 'im'), kind: 'note', x: 200, y: 0, text: 'Mid' });
    g = placeItem(g, A, { memberId: 'leaf', nodeRef: itemRef('board-A', 'il'), kind: 'note', x: 400, y: 0, text: 'Leaf' });
    g = placeItem(g, A, { memberId: 'sib', nodeRef: itemRef('board-A', 'is'), kind: 'note', x: 200, y: 200, text: 'Sib' });
    g = placeItem(g, A, { memberId: 'r-mid', nodeRef: itemRef('board-A', 'crm'), kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'root', toMemberId: 'mid' } });
    g = placeItem(g, A, { memberId: 'mid-leaf', nodeRef: itemRef('board-A', 'cml'), kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'mid', toMemberId: 'leaf' } });
    g = placeItem(g, A, { memberId: 'r-sib', nodeRef: itemRef('board-A', 'crs'), kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'root', toMemberId: 'sib' } });
    return g;
  }

  it('branchMemberIds(mid) → duplicate clones {mid,leaf} + their internal arrow, dropping the parent link', () => {
    const ga = mindMap();
    const all = readItems(ga, A);

    // #186: the branch rooted at `mid` is {mid, leaf}.
    const branch = new Set(branchMemberIds(all, 'mid'));
    expect([...branch].sort()).toEqual(['leaf', 'mid']);

    // The Alt-drag/⌘D copy set = the branch nodes + every connector (copyItemsToClipboard
    // keeps only the ones whose BOTH endpoints are in the set).
    const copySet = all.filter((i) => branch.has(i.memberId) || i.kind === 'connector');
    setBoardClipboard(copyItemsToClipboard(copySet));
    const gb = pasteWithPlan(emptyGraph(), 'board-B', B, 1000, 0);
    const pasted = readItems(gb, B);

    const nodes = pasted.filter((i) => i.kind !== 'connector');
    const conns = pasted.filter((i) => i.kind === 'connector');
    // Two nodes cloned (mid, leaf); ONE internal connector (mid→leaf); the parent link
    // root→mid is dropped (root wasn't in the branch).
    expect(nodes.map((n) => n.text).sort()).toEqual(['Leaf', 'Mid']);
    expect(conns).toHaveLength(1);

    // The surviving connector joins the two CLONES — a connected subtree, not a dangling edge.
    const nodeIds = new Set(nodes.map((n) => n.memberId));
    expect(nodeIds.has(conns[0].extra?.fromMemberId as string)).toBe(true);
    expect(nodeIds.has(conns[0].extra?.toMemberId as string)).toBe(true);
    // …and never references the originals.
    expect([conns[0].extra?.fromMemberId, conns[0].extra?.toMemberId]).not.toContain('mid');
    expect([conns[0].extra?.fromMemberId, conns[0].extra?.toMemberId]).not.toContain('leaf');
  });
});

// ── #204: a STAMP (a NEW item kind) composes with the generic clipboard/paste primitive —
//    it survives a cross-board copy→paste with its kind + glyph (carried in `text`) intact,
//    proving a new kind rides the blind carrier with ZERO kind-specific handling. The unit
//    test (stamp-tool.test.tsx) proves the renderer; THIS proves the kind flows through the
//    real place/read + clipboard composition, alongside ordinary notes.
describe('a stamp survives cross-board copy→paste (new kind rides the blind carrier, #204)', () => {
  it('copies a note + a stamp on board A → both materialize on board B, stamp kind + emoji preserved', () => {
    let ga = placeItem(emptyGraph(), A, { memberId: 'n1', nodeRef: itemRef('board-A', 'i1'), kind: 'note', x: 0, y: 0, text: 'idea' });
    ga = placeItem(ga, A, { memberId: 's1', nodeRef: itemRef('board-A', 'is'), kind: 'stamp', x: 40, y: 60, text: '🔥' });

    setBoardClipboard(copyItemsToClipboard(readItems(ga, A)));
    const gb = pasteOnto(emptyGraph(), 'board-B', B, 500, 500);
    const pasted = readItems(gb, B);

    expect(pasted).toHaveLength(2);
    const stamp = pasted.find((i) => i.kind === 'stamp');
    expect(stamp).toBeDefined();
    expect(stamp!.text).toBe('🔥'); // the glyph (stored in text) survives the blind carrier

    // Relative layout preserved (the stamp is +40,+60 from the note) — anchored at paste origin.
    const note = pasted.find((i) => i.kind === 'note')!;
    expect(stamp!.x - note.x).toBe(40);
    expect(stamp!.y - note.y).toBe(60);

    // Source board A untouched.
    expect(readItems(ga, A).map((i) => i.memberId).sort()).toEqual(['n1', 's1']);
  });
});
