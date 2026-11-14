// packages/group/read-data/duplicate-board.test.ts
//
// Proof for `duplicateBoard` / `copyBoardContents` — the data-integrity-critical
// part: a full board copy must REMAP connector endpoints to the new board's member
// ids (no dangling edges), RECURSE into nested sections, and leave the SOURCE board
// untouched. A wrong remap silently corrupts the duplicate, so this is unit-tested.

import { describe, expect, it } from 'vitest';
import { emptyGraph, membersOf } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import {
  addBoard,
  boardIndexRef,
  boardRootRef,
  boardToTemplate,
  duplicateBoard,
  groupItems,
  itemRef,
  placeItem,
  placeSection,
  readBoards,
  readItems,
  sectionRef,
  setBoardBackground,
} from './group-board-model';

const idx = boardIndexRef('surf');

/** Build a source board: notes A,B at root + a connector A→B + a section wrapping D,E. */
function buildSource() {
  let g = emptyGraph();
  g = addBoard(g, idx, { memberId: 'bm-src', boardId: 'src', title: 'Source' });
  const root = boardRootRef('src');
  g = placeItem(g, root, { memberId: 'A', nodeRef: itemRef('src', 'iA'), kind: 'note', x: 0, y: 0, text: 'A' });
  g = placeItem(g, root, { memberId: 'B', nodeRef: itemRef('src', 'iB'), kind: 'note', x: 200, y: 0, text: 'B' });
  // A connector is a member whose extra carries the two endpoint member ids.
  g = placeItem(g, root, {
    memberId: 'C', nodeRef: itemRef('src', 'iC'), kind: 'connector', x: 0, y: 0,
    extra: { fromMemberId: 'A', toMemberId: 'B', label: 'rel' },
  });
  g = placeItem(g, root, { memberId: 'D', nodeRef: itemRef('src', 'iD'), kind: 'note', x: 0, y: 200, text: 'D' });
  g = placeItem(g, root, { memberId: 'E', nodeRef: itemRef('src', 'iE'), kind: 'note', x: 200, y: 200, text: 'E' });
  // Group D,E into a section (a nested group → tests recursion).
  g = groupItems(g, root, ['D', 'E'], { sectionNodeRef: sectionRef('src', 'sS'), wrapperMemberId: 'S', x: 0, y: 200, text: 'Sec' });
  return g;
}

describe('duplicateBoard', () => {
  it('copies every root member, recurses sections, remaps the connector, and leaves the source intact', () => {
    let g = buildSource();
    let n = 0;
    const mint = () => `x${n++}`;
    g = duplicateBoard(g, idx, { srcBoardId: 'src', newBoardId: 'dup', newMemberId: 'bm-dup', title: 'Source copy', mint });

    const srcRoot = boardRootRef('src');
    const dupRoot = boardRootRef('dup');
    const srcItems = readItems(g, srcRoot);
    const dupItems = readItems(g, dupRoot);

    // Same top-level shape (note A, note B, connector C, section S).
    expect(dupItems.length).toBe(srcItems.length);
    expect(dupItems.length).toBe(4);

    // The duplicated connector points at the duplicated A and B (NEW ids), not the old ones.
    const dupConn = dupItems.find((i) => i.extra?.fromMemberId && i.extra?.toMemberId)!;
    expect(dupConn).toBeTruthy();
    const dupA = dupItems.find((i) => i.text === 'A')!;
    const dupB = dupItems.find((i) => i.text === 'B')!;
    expect(dupConn.extra!.fromMemberId).toBe(dupA.memberId);
    expect(dupConn.extra!.toMemberId).toBe(dupB.memberId);
    // The remap must have CHANGED the ids — they cannot still reference the source.
    expect(dupConn.extra!.fromMemberId).not.toBe('A');
    expect(dupConn.extra!.toMemberId).not.toBe('B');
    expect(dupA.memberId).not.toBe('A');
    // The connector kept its non-id payload (label).
    expect(dupConn.extra!.label).toBe('rel');

    // The nested section was copied WITH its two children (recursion). Resolve the
    // section member's real (minted) nodeRef from the raw graph, then read its members.
    const dupSection = dupItems.find((i) => i.isSection)!;
    expect(dupSection).toBeTruthy();
    const dupSectionMember = membersOf(g, dupRoot).find((m) => m.memberId === dupSection.memberId)!;
    expect(dupSectionMember.nodeRef.parts?.board).toBe('dup'); // address remapped to the new board
    const dupSectionChildren = readItems(g, dupSectionMember.nodeRef);
    expect(dupSectionChildren.length).toBe(2);
    expect(dupSectionChildren.map((c) => c.text).sort()).toEqual(['D', 'E']);
    // Those children are NEW ids, not the source's D/E.
    expect(dupSectionChildren.map((c) => c.memberId)).not.toContain('D');

    // SOURCE board is untouched: still 4 root items, connector still points at A,B.
    expect(srcItems.length).toBe(4);
    const srcConn = srcItems.find((i) => i.extra?.fromMemberId)!;
    expect(srcConn.extra!.fromMemberId).toBe('A');
    expect(srcConn.extra!.toMemberId).toBe('B');

    // New board is registered in the index with the copy title.
    const dupEntry = readBoards(g, idx).find((b) => b.boardId === 'dup');
    expect(dupEntry?.title).toBe('Source copy');
  });

  it('carries the source board background onto the duplicate', () => {
    let g = buildSource();
    g = setBoardBackground(g, idx, 'bm-src', 'graph-paper');
    let n = 0;
    g = duplicateBoard(g, idx, { srcBoardId: 'src', newBoardId: 'dup', newMemberId: 'bm-dup', title: 'Source copy', mint: () => `x${n++}` });
    const dupEntry = readBoards(g, idx).find((b) => b.boardId === 'dup');
    expect(dupEntry?.background).toBe('graph-paper');
  });
});

// ---------------------------------------------------------------------------
// SSOT deep-copy engine (copyBoardContents → boardToTemplate → materializeItems).
// The old copyBoardContents copied section presentation VERBATIM; the unified path
// routes through placeSection, so a section's frame styling (border/aspect/caption)
// must survive — this is the fidelity gap the connector/section tests above miss.
// ---------------------------------------------------------------------------
describe('copyBoardContents SSOT unification — styled-frame + round-trip fidelity', () => {
  /** A source board whose section is a STYLED FRAME (extra presentation beyond x/y/w/h/text). */
  function buildFramedSource() {
    let g = emptyGraph();
    g = addBoard(g, idx, { memberId: 'bm-fr', boardId: 'fr', title: 'Framed' });
    const root = boardRootRef('fr');
    // A presentation frame carrying #176 caption + #177 aspect + #198 border — all in extra.
    g = placeSection(g, root, {
      memberId: 'F',
      sectionNodeRef: sectionRef('fr', 'sF'),
      x: 10,
      y: 20,
      w: 640,
      h: 360,
      text: 'Chapter 1',
      extra: { frameCaption: 'Speaker notes', aspect: '16:9', border: { color: '#f0f', width: 3 } },
    });
    g = placeItem(g, sectionRef('fr', 'sF'), { memberId: 'child', nodeRef: itemRef('fr', 'iC'), kind: 'note', x: 0, y: 0, text: 'inside' });
    return g;
  }

  it('a duplicated board keeps its section frame styling (border/aspect/caption) verbatim', () => {
    let g = buildFramedSource();
    let n = 0;
    g = duplicateBoard(g, idx, { srcBoardId: 'fr', newBoardId: 'fr-dup', newMemberId: 'bm-frdup', title: 'Framed copy', mint: () => `f${n++}` });

    const dupRoot = boardRootRef('fr-dup');
    const dupSectionMember = membersOf(g, dupRoot).find((m) => m.presentation?.kind === 'section')!;
    expect(dupSectionMember).toBeTruthy();
    const pres = dupSectionMember.presentation as Record<string, unknown>;
    // Core section identity preserved…
    expect(pres.text).toBe('Chapter 1');
    expect(pres.w).toBe(640);
    // …AND the frame styling that placeSection would have dropped before the extra fix.
    expect(pres.frameCaption).toBe('Speaker notes');
    expect(pres.aspect).toBe('16:9');
    expect(pres.border).toEqual({ color: '#f0f', width: 3 });
    // The child inside the section came along (recursion).
    const dupSectionChildren = readItems(g, dupSectionMember.nodeRef);
    expect(dupSectionChildren.map((c) => c.text)).toEqual(['inside']);
  });

  it('boardToTemplate is the faithful inverse: core keys as fields, styling in extra, connector as from/to, section as children', () => {
    const g = buildSource(); // notes A,B + connector C(A→B) + section S wrapping D,E
    const items = boardToTemplate(g, 'src');
    // Same top-level shape/order (D,E are children of section S, not top-level).
    expect(items.map((i) => i.id)).toEqual(['A', 'B', 'C', 'S']);
    const conn = items.find((i) => i.id === 'C')!;
    // Connector endpoints surfaced as from/to (by SOURCE id), label kept in extra.
    expect(conn.from).toBe('A');
    expect(conn.to).toBe('B');
    expect(conn.extra?.label).toBe('rel');
    // A note carries NO from/to/children and no leftover core keys in extra.
    const noteA = items.find((i) => i.id === 'A')!;
    expect(noteA.from).toBeUndefined();
    expect(noteA.children).toBeUndefined();
    expect(noteA.extra).toBeUndefined();
    // The section is a children-bearing descriptor wrapping D and E.
    const section = items.find((i) => i.id === 'S')!;
    expect(section.children?.map((c) => c.id).sort()).toEqual(['D', 'E']);
  });
});

// ---------------------------------------------------------------------------
// Adversarial gauntlet (CLAUDE.md mandate for a new primitive): the SSOT engine
// must survive the HOSTILE composition — sections nested 3 deep, a styled frame
// at depth, and a connector INSIDE the deepest section whose endpoints cross TWO
// section boundaries up to a root node. If cross-boundary remap or deep styling
// needed a special case, the engine is LEGO not clay.
// ---------------------------------------------------------------------------
describe('copyBoardContents adversarial — deep nesting + cross-boundary connector remap', () => {
  const idxA = boardIndexRef('adv-surf');

  function firstMemberWhere(g: ReturnType<typeof emptyGraph>, ref: ReturnType<typeof boardRootRef>, pred: (p: Record<string, unknown>) => boolean) {
    return membersOf(g, ref).find((m) => pred((m.presentation ?? {}) as Record<string, unknown>));
  }

  it('duplicates a 3-deep nested board, keeps a deep styled frame, and remaps a 2-boundary-crossing connector', () => {
    let g = emptyGraph();
    g = addBoard(g, idxA, { memberId: 'bm', boardId: 'adv', title: 'Adversary' });
    const root = boardRootRef('adv');
    // root: a note ROOT + section S1 (styled frame)
    g = placeItem(g, root, { memberId: 'ROOT', nodeRef: itemRef('adv', 'iR'), kind: 'note', x: 0, y: 0, w: 100, h: 60, text: 'ROOT' });
    g = placeSection(g, root, { memberId: 'S1', sectionNodeRef: sectionRef('adv', 's1'), x: 10, y: 10, w: 800, h: 600, text: 'Outer', extra: { aspect: '4:3', border: { color: '#0f0', width: 2 } } });
    // S1 → section S2 (deeper)
    g = placeSection(g, sectionRef('adv', 's1'), { memberId: 'S2', sectionNodeRef: sectionRef('adv', 's2'), x: 20, y: 20, w: 400, h: 300, text: 'Inner' });
    // S2 → note A2 + a connector A2 -> ROOT (endpoints cross S2 and S1 boundaries up to root)
    g = placeItem(g, sectionRef('adv', 's2'), { memberId: 'A2', nodeRef: itemRef('adv', 'iA2'), kind: 'note', x: 0, y: 0, w: 80, h: 40, text: 'deep' });
    g = placeItem(g, sectionRef('adv', 's2'), { memberId: 'X', nodeRef: itemRef('adv', 'iX'), kind: 'connector', x: 0, y: 0, w: 1, h: 1, extra: { fromMemberId: 'A2', toMemberId: 'ROOT', label: 'up' } });

    let n = 0;
    g = duplicateBoard(g, idxA, { srcBoardId: 'adv', newBoardId: 'advC', newMemberId: 'bmC', title: 'Adversary copy', mint: () => `a${n++}` });

    const dupRoot = boardRootRef('advC');
    const dupRootNote = firstMemberWhere(g, dupRoot, (p) => p.text === 'ROOT')!;
    const dupS1 = firstMemberWhere(g, dupRoot, (p) => p.kind === 'section')!;
    // Deep styled frame preserved at depth 1.
    expect((dupS1.presentation as Record<string, unknown>).aspect).toBe('4:3');
    expect((dupS1.presentation as Record<string, unknown>).border).toEqual({ color: '#0f0', width: 2 });

    // Descend: S1 → S2 → {A2, connector X}. All ids are freshly minted (not the source's).
    const dupS2 = firstMemberWhere(g, dupS1.nodeRef, (p) => p.kind === 'section')!;
    expect(dupS2).toBeTruthy();
    const dupA2 = firstMemberWhere(g, dupS2.nodeRef, (p) => p.text === 'deep')!;
    const dupConn = firstMemberWhere(g, dupS2.nodeRef, (p) => typeof p.fromMemberId === 'string')!;
    const cp = dupConn.presentation as Record<string, unknown>;
    // The connector deep inside S2 was remapped ACROSS two section boundaries:
    // from → the duplicated deep note, to → the duplicated ROOT note at the top.
    expect(cp.fromMemberId).toBe(dupA2.memberId);
    expect(cp.toMemberId).toBe(dupRootNote.memberId);
    // Remapped, not dangling at the source ids.
    expect(cp.fromMemberId).not.toBe('A2');
    expect(cp.toMemberId).not.toBe('ROOT');
    expect(cp.label).toBe('up'); // non-id payload survived

    // Source board untouched: its deep connector still points at the ORIGINAL ids.
    const srcS1 = firstMemberWhere(g, boardRootRef('adv'), (p) => p.kind === 'section')!;
    const srcS2 = firstMemberWhere(g, srcS1.nodeRef, (p) => p.kind === 'section')!;
    const srcConn = firstMemberWhere(g, srcS2.nodeRef, (p) => typeof p.fromMemberId === 'string')!;
    expect((srcConn.presentation as Record<string, unknown>).fromMemberId).toBe('A2');
    expect((srcConn.presentation as Record<string, unknown>).toMemberId).toBe('ROOT');
  });
});
