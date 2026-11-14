// packages/group/read-data/group-board.test.ts
//
// Proof for the spatial Vision Board canvas model + live store wiring. The pure
// model (place typed items at world positions, read them back, move, remove) AND
// the store (BFS read folds records; mutate diffs before→after to a write-batch).
// The engine is mocked at the sender boundary; the real fold/diff logic runs.

import { describe, expect, it, vi } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import {
  addBoard,
  addBoardEntry,
  duplicateBoard,
  carryBoardLook,
  archiveBoard,
  archiveStaleCadenceBoards,
  boardIndexRef,
  boardRootRef,
  cadenceBoardId,
  cadenceBucket,
  cadenceTitle,
  ensureCadenceBoard,
  groupItems,
  hasBoard,
  readActiveBoards,
  readArchivedBoards,
  readBoards,
  removeBoard,
  renameBoard,
  setBoardBackground,
  setBoardGridSnap,
  setBoardAppearanceKey,
  applyAppearanceProfileToBoard,
  restoreBoard,
  isBoardEmpty,
  itemRef,
  MIN_ITEM_H,
  MIN_ITEM_W,
  moveItem,
  moveItemToGroup,
  patchItem,
  placeItem,
  resizeItem,
  placeSection,
  readItems,
  readPlaceableSurface,
  removeItem,
  sectionRef,
  ungroupItems,
} from './group-board-model';
import { createGroupBoardStore, loadGroupGraphFromRoots } from './read-group-board';

const BOARD = 'vision-board';
const root = boardRootRef(BOARD);

describe('group-board-model — spatial canvas item logic', () => {
  it('places a typed item at a world position and reads it back', () => {
    const g = placeItem(emptyGraph(), root, {
      memberId: 'm1',
      nodeRef: itemRef(BOARD, 'i1'),
      kind: 'note',
      x: 120,
      y: 80,
      text: 'Win Wimbledon',
    });
    const items = readItems(g, root);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'note', x: 120, y: 80, text: 'Win Wimbledon' });
    expect(isBoardEmpty(g, root)).toBe(false);
  });

  it('readItems returns a COPY of extra — mutating a read result does not corrupt the graph (I3 immutability)', () => {
    const g = placeItem(emptyGraph(), root, {
      memberId: 'c1', nodeRef: itemRef(BOARD, 'i1'), kind: 'connector', x: 0, y: 0,
      extra: { fromMemberId: 'a', toMemberId: 'b' },
    });
    const item = readItems(g, root)[0];
    (item.extra as Record<string, unknown>).toMemberId = 'HACKED'; // a careless caller mutates the read result
    // a fresh read from the SAME graph is unaffected — the graph was not corrupted
    expect((readItems(g, root)[0].extra as Record<string, unknown>).toMemberId).toBe('b');
  });

  it('extra can NOT override core geometry/kind — typed args are authoritative (untrusted-data guard)', () => {
    // A hostile capsule / imported template item carrying reserved keys in extra must not corrupt placement.
    const g = placeItem(emptyGraph(), root, {
      memberId: 'm1', nodeRef: itemRef(BOARD, 'i1'), kind: 'note', x: 10, y: 20,
      extra: { x: 999, y: 999, w: 999, kind: 'connector', fromMemberId: 'a', toMemberId: 'b', metric: { current: 1, target: 2 } },
    });
    const it = readItems(g, root)[0];
    expect(it.kind).toBe('note'); // NOT 'connector' from extra
    expect(it.x).toBe(10); // NOT 999 from extra
    expect(it.y).toBe(20);
    // non-reserved extra is preserved intact
    expect((it.extra as Record<string, unknown>).metric).toEqual({ current: 1, target: 2 });
  });

  it('keeps kind as a raw data key (image/media/generated/anything)', () => {
    let g = placeItem(emptyGraph(), root, { memberId: 'm1', nodeRef: itemRef(BOARD, 'i1'), kind: 'image', x: 0, y: 0, src: 'x.png' });
    g = placeItem(g, root, { memberId: 'm2', nodeRef: itemRef(BOARD, 'i2'), kind: 'whatever-the-owner-invents', x: 50, y: 50 });
    expect(readItems(g, root).map((i) => i.kind)).toEqual(['image', 'whatever-the-owner-invents']);
  });

  it('moves an item to a new world position (drag)', () => {
    let g = placeItem(emptyGraph(), root, { memberId: 'm1', nodeRef: itemRef(BOARD, 'i1'), kind: 'note', x: 0, y: 0 });
    g = moveItem(g, root, 'm1', 300, 220);
    expect(readItems(g, root)[0]).toMatchObject({ x: 300, y: 220 });
  });

  it('removes an item', () => {
    let g = placeItem(emptyGraph(), root, { memberId: 'm1', nodeRef: itemRef(BOARD, 'i1'), kind: 'note', x: 0, y: 0, text: 'A' });
    g = placeItem(g, root, { memberId: 'm2', nodeRef: itemRef(BOARD, 'i2'), kind: 'note', x: 10, y: 10, text: 'B' });
    g = removeItem(g, root, 'm1');
    expect(readItems(g, root).map((i) => i.text)).toEqual(['B']);
  });
});

describe('group-board-model — infinite-nesting sections', () => {
  function twoNotes() {
    let g = placeItem(emptyGraph(), root, { memberId: 'm1', nodeRef: itemRef(BOARD, 'i1'), kind: 'note', x: 40, y: 30, text: 'A' });
    g = placeItem(g, root, { memberId: 'm2', nodeRef: itemRef(BOARD, 'i2'), kind: 'note', x: 90, y: 60, text: 'B' });
    return g;
  }

  it('groups two items into a section member; drilling in shows the two children', () => {
    const g = groupItems(twoNotes(), root, ['m1', 'm2'], {
      sectionNodeRef: sectionRef(BOARD, 's1'),
      wrapperMemberId: 'sm1',
      x: 40,
      y: 30,
      text: 'Goals',
    });
    // Parent now holds ONE member: the section, marked isSection with childCount 2.
    const top = readItems(g, root);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ memberId: 'sm1', kind: 'section', isSection: true, childCount: 2, text: 'Goals' });
    // Drill in via the section's own group ref → the two original notes, order preserved.
    const inside = readItems(g, sectionRef(BOARD, 's1'));
    expect(inside.map((i) => i.text)).toEqual(['A', 'B']);
    inside.forEach((i) => expect(i.isSection).toBe(false));
  });

  it('a leaf item reports childCount 0 (only sections count children)', () => {
    expect(readItems(twoNotes(), root).every((i) => i.childCount === 0 && !i.isSection)).toBe(true);
  });

  it('grouping fewer than two items is a no-op (needs a real selection)', () => {
    const g = twoNotes();
    expect(groupItems(g, root, ['m1'], { sectionNodeRef: sectionRef(BOARD, 's1'), wrapperMemberId: 'sm1', x: 0, y: 0 })).toBe(g);
  });

  it('ungroup dissolves a section: children rejoin the parent in place', () => {
    let g = groupItems(twoNotes(), root, ['m1', 'm2'], { sectionNodeRef: sectionRef(BOARD, 's1'), wrapperMemberId: 'sm1', x: 0, y: 0 });
    g = ungroupItems(g, root, 'sm1');
    const top = readItems(g, root);
    expect(top.map((i) => i.text)).toEqual(['A', 'B']);
    expect(top.every((i) => !i.isSection)).toBe(true);
  });

  it('places an EMPTY section (folder), then adding inside it raises its child count', () => {
    // Folders-first: make an empty section at the root.
    let g = placeSection(emptyGraph(), root, { sectionNodeRef: sectionRef(BOARD, 's1'), memberId: 'sm1', x: 50, y: 50, text: 'Later' });
    const top = readItems(g, root);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ memberId: 'sm1', kind: 'section', isSection: true, childCount: 0, text: 'Later' });
    // The empty section's own group exists (so it persists) and reads as empty.
    expect(readItems(g, sectionRef(BOARD, 's1'))).toEqual([]);
    // Drill in and add an item INTO the section → child count becomes 1.
    g = placeItem(g, sectionRef(BOARD, 's1'), { memberId: 'm1', nodeRef: itemRef(BOARD, 'i1'), kind: 'note', x: 0, y: 0, text: 'A' });
    expect(readItems(g, root)[0].childCount).toBe(1);
    expect(readItems(g, sectionRef(BOARD, 's1')).map((i) => i.text)).toEqual(['A']);
  });

  it('drags a loose item INTO a section (move between groups), raising its count', () => {
    // A section with one note, plus a loose note at the root.
    let g = placeSection(emptyGraph(), root, { sectionNodeRef: sectionRef(BOARD, 's1'), memberId: 'sm1', x: 0, y: 0, text: 'Box' });
    g = placeItem(g, sectionRef(BOARD, 's1'), { memberId: 'mIn', nodeRef: itemRef(BOARD, 'iIn'), kind: 'note', x: 0, y: 0, text: 'inside' });
    g = placeItem(g, root, { memberId: 'mLoose', nodeRef: itemRef(BOARD, 'iLoose'), kind: 'note', x: 300, y: 0, text: 'loose' });
    expect(readItems(g, root).map((i) => i.memberId).sort()).toEqual(['mLoose', 'sm1']);
    // Drop the loose note onto the section → it moves in; root loses it; count → 2.
    g = moveItemToGroup(g, root, sectionRef(BOARD, 's1'), 'mLoose');
    expect(readItems(g, root).map((i) => i.memberId)).toEqual(['sm1']);
    expect(readItems(g, root)[0].childCount).toBe(2);
    expect(readItems(g, sectionRef(BOARD, 's1')).map((i) => i.text)).toEqual(['inside', 'loose']);
  });

  it('moves an item OUT of a section back up to the parent (folder symmetry)', () => {
    let g = placeSection(emptyGraph(), root, { sectionNodeRef: sectionRef(BOARD, 's1'), memberId: 'sm1', x: 0, y: 0 });
    g = placeItem(g, sectionRef(BOARD, 's1'), { memberId: 'mIn', nodeRef: itemRef(BOARD, 'iIn'), kind: 'note', x: 0, y: 0, text: 'free me' });
    expect(readItems(g, root)[0].childCount).toBe(1);
    // Move it from the section back to the root → root gains it, section empties.
    g = moveItemToGroup(g, sectionRef(BOARD, 's1'), root, 'mIn');
    const atRoot = readItems(g, root);
    expect(atRoot.find((i) => i.memberId === 'mIn')?.text).toBe('free me');
    expect(atRoot.find((i) => i.memberId === 'sm1')?.childCount).toBe(0);
    expect(readItems(g, sectionRef(BOARD, 's1'))).toEqual([]);
  });

  it('a cycle-forming move (a section into its own child) is a safe no-op', () => {
    // Outer section contains inner section.
    let g = placeSection(emptyGraph(), root, { sectionNodeRef: sectionRef(BOARD, 'outer'), memberId: 'mOuter', x: 0, y: 0 });
    g = placeSection(g, sectionRef(BOARD, 'outer'), { sectionNodeRef: sectionRef(BOARD, 'inner'), memberId: 'mInner', x: 0, y: 0 });
    // Dropping outer into inner would cycle → unchanged graph.
    const same = moveItemToGroup(g, root, sectionRef(BOARD, 'inner'), 'mOuter');
    expect(same).toBe(g);
  });

  it('nests infinitely — a section of sections (leaf I2, zero new code)', () => {
    let g = groupItems(twoNotes(), root, ['m1', 'm2'], { sectionNodeRef: sectionRef(BOARD, 's1'), wrapperMemberId: 'sm1', x: 0, y: 0, text: 'Inner' });
    g = placeItem(g, root, { memberId: 'm3', nodeRef: itemRef(BOARD, 'i3'), kind: 'note', x: 200, y: 10, text: 'C' });
    g = groupItems(g, root, ['sm1', 'm3'], { sectionNodeRef: sectionRef(BOARD, 's2'), wrapperMemberId: 'sm2', x: 0, y: 0, text: 'Outer' });
    const top = readItems(g, root);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ memberId: 'sm2', isSection: true, childCount: 2, text: 'Outer' });
    const mid = readItems(g, sectionRef(BOARD, 's2'));
    expect(mid.map((i) => i.text)).toEqual(['Inner', 'C']);
    expect(mid.find((i) => i.text === 'Inner')).toMatchObject({ isSection: true, childCount: 2 });
    expect(readItems(g, sectionRef(BOARD, 's1')).map((i) => i.text)).toEqual(['A', 'B']);
  });
});

describe('group-board-model — multiple boards (board index)', () => {
  const index = boardIndexRef('vision-board');

  it('registers boards in an index; each points at its own root group', () => {
    let g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'vision-board', title: 'Vision Board' });
    g = addBoard(g, index, { memberId: 'b2', boardId: 'board-trip', title: 'Italy Trip' });
    const boards = readBoards(g, index);
    expect(boards.map((b) => b.boardId)).toEqual(['vision-board', 'board-trip']);
    expect(boards.map((b) => b.title)).toEqual(['Vision Board', 'Italy Trip']);
  });

  it('a board added to the index gets its own empty root that persists (childCount 0)', () => {
    const g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'board-x', title: 'X' });
    // The new board root exists as an empty group — items placed there are isolated per board.
    expect(readItems(g, boardRootRef('board-x'))).toEqual([]);
  });

  it('items live PER BOARD: a single index-rooted graph holds every board independently', () => {
    let g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'a', title: 'A' });
    g = addBoard(g, index, { memberId: 'b2', boardId: 'b', title: 'B' });
    g = placeItem(g, boardRootRef('a'), { memberId: 'mA', nodeRef: itemRef('a', 'i1'), kind: 'note', x: 0, y: 0, text: 'on A' });
    g = placeItem(g, boardRootRef('b'), { memberId: 'mB', nodeRef: itemRef('b', 'i1'), kind: 'note', x: 0, y: 0, text: 'on B' });
    expect(readItems(g, boardRootRef('a')).map((i) => i.text)).toEqual(['on A']);
    expect(readItems(g, boardRootRef('b')).map((i) => i.text)).toEqual(['on B']);
  });

  it('addBoard is idempotent on an existing board id (no duplicate registration)', () => {
    let g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'a', title: 'A' });
    g = addBoard(g, index, { memberId: 'b2', boardId: 'a', title: 'A again' });
    expect(readBoards(g, index)).toHaveLength(1);
    expect(hasBoard(g, index, 'a')).toBe(true);
    expect(hasBoard(g, index, 'nope')).toBe(false);
  });

  it('removeBoard permanently unregisters a board from the index', () => {
    let g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'a', title: 'A' });
    g = addBoard(g, index, { memberId: 'b2', boardId: 'b', title: 'B' });
    g = removeBoard(g, index, 'b1');
    expect(readBoards(g, index).map((bd) => bd.boardId)).toEqual(['b']);
    expect(hasBoard(g, index, 'a')).toBe(false);
  });

  it('archive hides a board from the active switcher but keeps it (restorable)', () => {
    let g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'a', title: 'A' });
    g = addBoard(g, index, { memberId: 'b2', boardId: 'b', title: 'B' });
    g = placeItem(g, boardRootRef('a'), { memberId: 'mA', nodeRef: itemRef('a', 'i1'), kind: 'note', x: 0, y: 0, text: 'keep me' });
    g = archiveBoard(g, index, 'b1');
    // Active switcher drops A; the archive holds it; its items are untouched.
    expect(readActiveBoards(g, index).map((bd) => bd.boardId)).toEqual(['b']);
    expect(readArchivedBoards(g, index).map((bd) => bd.boardId)).toEqual(['a']);
    expect(hasBoard(g, index, 'a')).toBe(true); // still registered, just archived
    expect(readItems(g, boardRootRef('a')).map((i) => i.text)).toEqual(['keep me']);
    // Restore brings it back to the active switcher.
    g = restoreBoard(g, index, 'b1');
    expect(readActiveBoards(g, index).map((bd) => bd.boardId).sort()).toEqual(['a', 'b']);
    expect(readArchivedBoards(g, index)).toEqual([]);
    expect(readItems(g, boardRootRef('a')).map((i) => i.text)).toEqual(['keep me']);
  });

  it('archive-all-others: folding archiveBoard over every non-current board leaves exactly one active', () => {
    // The model composition behind the "Archive all other boards" switcher action
    // (declutter to the current board). Recoverable — the rest move to the archive.
    let g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'keep', title: 'Vision Board' });
    g = addBoard(g, index, { memberId: 'b2', boardId: 'junk-1', title: 'Proof137' });
    g = addBoard(g, index, { memberId: 'b3', boardId: 'junk-2', title: 'CtxMenu' });
    g = addBoard(g, index, { memberId: 'b4', boardId: 'junk-3', title: 'PngSrc' });
    const current = 'keep';
    // Fold archiveBoard over every active board except the current one (the exact
    // reduction archiveOtherBoards runs in GroupBoardPanel).
    for (const bd of readActiveBoards(g, index).filter((b) => b.boardId !== current)) {
      g = archiveBoard(g, index, bd.memberId);
    }
    expect(readActiveBoards(g, index).map((b) => b.boardId)).toEqual(['keep']);
    expect(readArchivedBoards(g, index).map((b) => b.boardId).sort()).toEqual(['junk-1', 'junk-2', 'junk-3']);
    // Every archived board is still registered + restorable (soft, not destroyed).
    expect(hasBoard(g, index, 'junk-2')).toBe(true);
    g = restoreBoard(g, index, 'b3');
    expect(readActiveBoards(g, index).map((b) => b.boardId).sort()).toEqual(['junk-2', 'keep']);
  });

  it('renameBoard updates the switcher title without touching the board contents', () => {
    let g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'a', title: 'A' });
    g = placeItem(g, boardRootRef('a'), { memberId: 'mA', nodeRef: itemRef('a', 'i1'), kind: 'note', x: 0, y: 0, text: 'keep' });
    g = renameBoard(g, index, 'b1', 'Renamed');
    expect(readBoards(g, index)[0].title).toBe('Renamed');
    expect(readItems(g, boardRootRef('a')).map((i) => i.text)).toEqual(['keep']);
  });

  it('rename-current-board: find the active board by boardId, rename it, empty keeps the old title', () => {
    // The composition behind the "Rename board" switcher action: resolve the current
    // board's member from its boardId (readActiveBoards.find), then renameBoard on it.
    let g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'keep', title: 'Vision Board' });
    g = addBoard(g, index, { memberId: 'b2', boardId: 'other', title: 'Other' });
    const current = 'keep';
    const entry = readActiveBoards(g, index).find((b) => b.boardId === current)!;
    expect(entry.memberId).toBe('b1');
    // A non-empty new title renames only the current board (sibling untouched).
    g = renameBoard(g, index, entry.memberId, 'Roadmap 2026'.trim() || entry.title);
    expect(readActiveBoards(g, index).find((b) => b.boardId === 'keep')!.title).toBe('Roadmap 2026');
    expect(readActiveBoards(g, index).find((b) => b.boardId === 'other')!.title).toBe('Other');
    // Empty/whitespace → the `trim() || old` guard keeps the existing title (never blanks it).
    const e2 = readActiveBoards(g, index).find((b) => b.boardId === 'keep')!;
    g = renameBoard(g, index, e2.memberId, '   '.trim() || e2.title);
    expect(readActiveBoards(g, index).find((b) => b.boardId === 'keep')!.title).toBe('Roadmap 2026');
  });

  it('setBoardBackground stores the surface id on the entry without touching contents', () => {
    let g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'a', title: 'A' });
    g = placeItem(g, boardRootRef('a'), { memberId: 'mA', nodeRef: itemRef('a', 'i1'), kind: 'note', x: 0, y: 0, text: 'keep' });
    expect(readBoards(g, index)[0].background).toBeUndefined();
    g = setBoardBackground(g, index, 'b1', 'blueprint');
    expect(readBoards(g, index)[0].background).toBe('blueprint');
    // It is a single-field merge: title + contents untouched.
    expect(readBoards(g, index)[0].title).toBe('A');
    expect(readItems(g, boardRootRef('a')).map((i) => i.text)).toEqual(['keep']);
    // Re-set replaces the id (last-write-wins on the one field).
    g = setBoardBackground(g, index, 'b1', 'grid');
    expect(readBoards(g, index)[0].background).toBe('grid');
  });

  it('setBoardGridSnap toggles the per-board snap flag independently of background/contents (#202)', () => {
    let g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'a', title: 'A' });
    g = placeItem(g, boardRootRef('a'), { memberId: 'mA', nodeRef: itemRef('a', 'i1'), kind: 'note', x: 0, y: 0, text: 'keep' });
    g = setBoardBackground(g, index, 'b1', 'grid'); // a coexisting per-board setting
    expect(readBoards(g, index)[0].gridSnap).toBeUndefined(); // absent → off by default
    g = setBoardGridSnap(g, index, 'b1', true);
    expect(readBoards(g, index)[0].gridSnap).toBe(true);
    // The other index-member fields are untouched by the single-field merge.
    expect(readBoards(g, index)[0].background).toBe('grid');
    expect(readBoards(g, index)[0].title).toBe('A');
    expect(readItems(g, boardRootRef('a')).map((i) => i.text)).toEqual(['keep']);
    // Toggling off collapses the flag back to a falsey read (never a lingering true).
    g = setBoardGridSnap(g, index, 'b1', false);
    expect(readBoards(g, index)[0].gridSnap).toBeUndefined();
  });

  it('setBoardAppearanceKey merges per-key, deletes on undefined, and coexists with other board fields (#225 P1)', () => {
    let g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'a', title: 'A' });
    g = placeItem(g, boardRootRef('a'), { memberId: 'mA', nodeRef: itemRef('a', 'i1'), kind: 'note', x: 0, y: 0, text: 'keep' });
    expect(readBoards(g, index)[0].appearance).toBeUndefined(); // absent → global-only cascade
    // Set one key.
    g = setBoardAppearanceKey(g, index, 'b1', 'sizeMode', 'scroll');
    expect(readBoards(g, index)[0].appearance).toEqual({ sizeMode: 'scroll' });
    // A SECOND key merges — it never clobbers the first (the L090 opaque-bag contract).
    g = setBoardAppearanceKey(g, index, 'b1', 'containerVariant', 'ghost');
    expect(readBoards(g, index)[0].appearance).toEqual({ sizeMode: 'scroll', containerVariant: 'ghost' });
    // The model never enumerates keys: a BRAND-NEW property flows through unchanged.
    g = setBoardAppearanceKey(g, index, 'b1', 'somethingInventedLater', 42);
    expect(readBoards(g, index)[0].appearance?.somethingInventedLater).toBe(42);
    // undefined DELETES the key (reset-to-default is first-class, not a sentinel).
    g = setBoardAppearanceKey(g, index, 'b1', 'somethingInventedLater', undefined);
    g = setBoardAppearanceKey(g, index, 'b1', 'containerVariant', undefined);
    expect(readBoards(g, index)[0].appearance).toEqual({ sizeMode: 'scroll' });
    // Deleting the LAST key collapses the whole bag back to undefined (no empty-object residue).
    g = setBoardAppearanceKey(g, index, 'b1', 'sizeMode', undefined);
    expect(readBoards(g, index)[0].appearance).toBeUndefined();
    // Sibling index-member fields + board contents are untouched throughout.
    expect(readBoards(g, index)[0].title).toBe('A');
    expect(readItems(g, boardRootRef('a')).map((i) => i.text)).toEqual(['keep']);
  });

  it('applyAppearanceProfileToBoard folds a whole preset profile onto the board at once (#225 P1 presets)', () => {
    let g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'a', title: 'A' });
    // Apply the "Focus" preset profile — both keys land on the board's appearance.
    g = applyAppearanceProfileToBoard(g, index, 'b1', { containerVariant: 'ghost', sizeMode: 'scroll' });
    expect(readBoards(g, index)[0].appearance).toEqual({ containerVariant: 'ghost', sizeMode: 'scroll' });
    // Applying another profile MERGES per-key, only overriding the keys it carries.
    g = applyAppearanceProfileToBoard(g, index, 'b1', { sizeMode: 'fill' });
    expect(readBoards(g, index)[0].appearance).toEqual({ containerVariant: 'ghost', sizeMode: 'fill' });
    // GENERIC over keys — a key the model never heard of flows through (L090).
    g = applyAppearanceProfileToBoard(g, index, 'b1', { markerGlyph: 'star' });
    expect(readBoards(g, index)[0].appearance?.markerGlyph).toBe('star');
    // An empty / undefined profile is a no-op (graph reference unchanged).
    expect(applyAppearanceProfileToBoard(g, index, 'b1', {})).toBe(g);
    expect(applyAppearanceProfileToBoard(g, index, 'b1', undefined)).toBe(g);
    // Sibling fields untouched.
    expect(readBoards(g, index)[0].title).toBe('A');
  });

  it('addBoardEntry registers a board WITHOUT materializing its root (clobber-safe seed)', () => {
    // The live-seed path: register the default board entry on an empty graph. ONLY
    // the index group is created — the board root is NOT, so persisting this diff
    // writes the index record alone and can never overwrite an existing board root.
    const g = addBoardEntry(emptyGraph(), index, { memberId: 'seed', boardId: 'vision-board', title: 'Vision Board' });
    expect(Object.keys(g.groups)).toHaveLength(1); // index only — NOT the board root
    expect(readBoards(g, index).map((b) => b.boardId)).toEqual(['vision-board']);
  });

  it('addBoard (new board) DOES materialize an empty root (so a brand-new board persists)', () => {
    const g = addBoard(emptyGraph(), index, { memberId: 'b1', boardId: 'fresh', title: 'Fresh' });
    expect(Object.keys(g.groups)).toHaveLength(2); // index + the new empty board root
    expect(readItems(g, boardRootRef('fresh'))).toEqual([]);
  });

  it('seeding then reloading preserves pre-existing items at the default root (zero migration)', () => {
    // Simulate the live board: items already at boardRootRef('vision-board').
    const existing = placeItem(emptyGraph(), boardRootRef('vision-board'), { memberId: 'm1', nodeRef: itemRef('vision-board', 'i1'), kind: 'note', x: 0, y: 0, text: 'existing' });
    // A graph that ALREADY contains the index entry (as a reload's BFS would find)
    // + the existing root: items survive, board is registered.
    const seeded = addBoardEntry(existing, index, { memberId: 'seed', boardId: 'vision-board', title: 'Vision Board' });
    expect(readItems(seeded, boardRootRef('vision-board')).map((i) => i.text)).toEqual(['existing']);
    expect(readBoards(seeded, index).map((b) => b.boardId)).toEqual(['vision-board']);
  });
});

describe('read-group-board — live store wiring (mocked engine)', () => {
  it('reloads separately addressed libraries with the board and deduplicates shared roots', async () => {
    const { smartSetIndexRef, readActiveSmartSets } = await import('./saved-smart-set');
    const library = smartSetIndexRef();
    const record = { groupRef: library, memberOrder: ['saved'], members: {
      saved: { memberId: 'saved', nodeRef: itemRef(BOARD, 'query'), presentation: {
        kind: 'smart-set', name: 'Notes', archived: false, recordId: 'query',
        record: { selection: { kindFamily: ['Note'] } },
      } },
    } };
    const payload = new TextEncoder().encode(JSON.stringify(record));
    const reply = new Uint8Array(6 + payload.length);
    reply[0] = 1; reply[1] = 1;
    new DataView(reply.buffer).setUint32(2, payload.length, true);
    reply.set(payload, 6);
    let calls = 0;
    const sender = vi.fn(async () => ({ payload: ++calls === 2 ? reply : new Uint8Array([0]) }));
    const graph = await createGroupBoardStore('scope:library', root, sender).load([library, root]);
    expect(sender).toHaveBeenCalledTimes(3);
    expect(readActiveSmartSets(graph, library)).toEqual([expect.objectContaining({ name: 'Notes' })]);
  });

  it.each([false, true])('orders observations and suppresses late callbacks after batch failure=%s', async (fail) => {
    const roots = [boardRootRef('first'), boardRootRef('second')];
    const reply = (ref: typeof root) => {
      const payload = new TextEncoder().encode(JSON.stringify({ groupRef: ref, memberOrder: [], members: {} }));
      const bytes = new Uint8Array(6 + payload.length + 5 + 34);
      bytes[0] = 1; bytes[1] = 1;
      new DataView(bytes.buffer).setUint32(2, payload.length, true);
      bytes.set(payload, 6);
      const offset = 6 + payload.length;
      bytes[offset] = 1;
      new DataView(bytes.buffer).setUint32(offset + 1, 34, true);
      bytes.set([31, 32], offset + 5);
      return { payload: bytes };
    };
    const pending: Array<{ resolve: (value: { payload: Uint8Array }) => void; reject: (error: Error) => void }> = [];
    const sender = vi.fn(() => new Promise<{ payload: Uint8Array }>((resolve, reject) => pending.push({ resolve, reject })));
    const observe = vi.fn();
    const loading = loadGroupGraphFromRoots('scope:ordered', roots, sender, observe);
    expect(pending).toHaveLength(2);
    if (fail) {
      pending[0].reject(new Error('read refused'));
      await expect(loading).rejects.toThrow('read refused');
      pending[1].resolve(reply(roots[1]));
      await Promise.resolve();
      expect(observe).not.toHaveBeenCalled();
    } else {
      pending[1].resolve(reply(roots[1]));
      await Promise.resolve();
      expect(observe).not.toHaveBeenCalled();
      pending[0].resolve(reply(roots[0]));
      await loading;
      const { groupRecordAddress } = await import('./group-eeaf');
      expect(observe.mock.calls.map(([observation]) => observation.address)).toEqual(roots.map(groupRecordAddress));
    }
  });

  it('starts independent sibling reads together, bounds demand, and deduplicates refs', async () => {
    const refs = Array.from({ length: 10 }, (_, i) => itemRef(BOARD, `parallel-${i}`));
    const memberOrder = [...refs.map((_, i) => `m${i}`), 'duplicate'];
    const members = Object.fromEntries(memberOrder.map((memberId, i) => [memberId, {
      memberId, nodeRef: refs[i % refs.length],
    }]));
    const payload = new TextEncoder().encode(JSON.stringify({ groupRef: root, memberOrder, members }));
    const reply = new Uint8Array(6 + payload.length);
    reply[0] = 1; reply[1] = 1;
    new DataView(reply.buffer).setUint32(2, payload.length, true);
    reply.set(payload, 6);
    const pending: Array<() => void> = [];
    let calls = 0;
    const sender = vi.fn(() => {
      if (++calls === 1) return Promise.resolve({ payload: reply });
      return new Promise<{ payload: Uint8Array }>(resolve => pending.push(() => resolve({ payload: new Uint8Array([0]) })));
    });
    const loading = createGroupBoardStore('scope:parallel', root, sender).load();
    await vi.waitFor(() => expect(pending).toHaveLength(8));
    expect(calls).toBe(9);
    pending.splice(0).reverse().forEach(resolve => resolve());
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending.splice(0).forEach(resolve => resolve());
    const graph = await loading;
    expect(calls).toBe(11);
    expect(Object.values(graph.groups)).toContainEqual(expect.objectContaining({ memberOrder }));
  });

  it('apply() writes one record per changed group; a no-op writes nothing', async () => {
    const writes: Array<{ target: string; payload: Uint8Array }> = [];
    const sender = vi.fn(async (request: { target: string; payload: Uint8Array }) => {
      writes.push(request);
      return { payload: new Uint8Array() };
    });
    const store = createGroupBoardStore('bitfield-studio', root, sender);

    const before = emptyGraph();
    const after = placeItem(before, root, { memberId: 'm1', nodeRef: itemRef(BOARD, 'i1'), kind: 'note', x: 1, y: 2 });
    await store.apply(before, after);
    expect(writes).toHaveLength(1);

    writes.length = 0;
    await store.apply(after, after);
    expect(writes).toHaveLength(0);
  });

  it('load() reads from the board root with IDENTITY-TEXT addressing and tolerates an absent board', async () => {
    const reads: Array<{ target: string; payload: Uint8Array }> = [];
    const { buildEngineReadCurrentRequestFromLabels } = await import('#workspace-records');
    const { groupRecordAddress } = await import('./group-eeaf');
    const notFoundReply = { payload: new Uint8Array([0]) };
    const sender = vi.fn(async (request: { target: string; payload: Uint8Array }) => {
      reads.push(request);
      return notFoundReply;
    });

    const store = createGroupBoardStore('bitfield-studio', root, sender);
    const graph = await store.load();
    expect(isBoardEmpty(graph, root)).toBe(true);

    expect(reads.length).toBeGreaterThanOrEqual(1);
    const identityRequest = buildEngineReadCurrentRequestFromLabels('bitfield-studio', groupRecordAddress(root), {
      addressMode: 'identity-text',
    }) as { payload: Uint8Array };
    expect(keyOf(reads[0].payload)).toBe(keyOf(identityRequest.payload));
    const labelHashRequest = buildEngineReadCurrentRequestFromLabels('bitfield-studio', groupRecordAddress(root)) as {
      payload: Uint8Array;
    };
    expect(keyOf(reads[0].payload)).not.toBe(keyOf(labelHashRequest.payload));
  });

  it('load() treats a thrown FE_ADDRESS_NOT_FOUND for a non-group member as a leaf and preserves the parent graph', async () => {
    const foundReply = (value: unknown): Uint8Array => {
      const payload = new TextEncoder().encode(JSON.stringify(value));
      const out = new Uint8Array(6 + payload.byteLength);
      out[0] = 1;
      out[1] = 1;
      new DataView(out.buffer).setUint32(2, payload.byteLength, true);
      out.set(payload, 6);
      return out;
    };
    const rootRecord = {
      groupRef: root,
      memberOrder: ['surface:feed'],
      members: {
        'surface:feed': {
          memberId: 'surface:feed',
          nodeRef: { family: 'placeable-surface', parts: { id: 'item-record.panel' } },
        },
      },
    };
    let readCount = 0;
    const sender = vi.fn(async () => {
      readCount += 1;
      if (readCount === 1) {
        return { payload: foundReply(rootRecord) };
      }
      const error = new Error('FE_ADDRESS_NOT_FOUND: Fact address not found') as Error & { code: string };
      error.code = 'FE_ADDRESS_NOT_FOUND';
      throw error;
    });

    const graph = await createGroupBoardStore('lakeside-community', root, sender).load();
    expect(Object.values(graph.groups)).toContainEqual(expect.objectContaining(rootRecord));
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('load() still fails closed for a non-absence transport error', async () => {
    const sender = vi.fn(async () => {
      throw new Error('network timeout');
    });
    await expect(createGroupBoardStore('lakeside-community', root, sender).load())
      .rejects.toThrow('network timeout');
  });
});

describe('calendar cadence boards — auto-rolling daily/weekly/monthly', () => {
  const idx = boardIndexRef(BOARD);

  it('buckets a date into a lexically-sortable key per unit (UTC)', () => {
    const d = new Date(Date.UTC(2026, 5, 27)); // 2026-06-27
    expect(cadenceBucket('day', d)).toBe('2026-06-27');
    expect(cadenceBucket('month', d)).toBe('2026-06');
    expect(cadenceBucket('year', d)).toBe('2026');
    expect(cadenceBucket('week', d)).toMatch(/^2026-W\d\d$/);
    // string order == chronological order within a unit
    expect(cadenceBucket('day', new Date(Date.UTC(2026, 5, 26))) < cadenceBucket('day', d)).toBe(true);
  });

  it('renders a human title for each unit', () => {
    expect(cadenceTitle('day', '2026-06-27')).toBe('June 27, 2026');
    expect(cadenceTitle('month', '2026-06')).toBe('June 2026');
    expect(cadenceTitle('year', '2026')).toBe('2026');
    expect(cadenceTitle('week', '2026-W26')).toBe('Week 26, 2026');
  });

  it('ensureCadenceBoard creates today\'s board once (idempotent) and tags it', () => {
    const d = new Date(Date.UTC(2026, 5, 27));
    const first = ensureCadenceBoard(emptyGraph(), idx, 'day', d, { memberId: 'c1' });
    expect(first.created).toBe(true);
    expect(first.boardId).toBe(cadenceBoardId('day', '2026-06-27'));
    const entry = readActiveBoards(first.graph, idx).find((b) => b.boardId === first.boardId)!;
    expect(entry.cadenceUnit).toBe('day');
    expect(entry.bucketKey).toBe('2026-06-27');
    expect(entry.title).toBe('June 27, 2026');
    // second call on the same day is a no-op (same graph, not created)
    const second = ensureCadenceBoard(first.graph, idx, 'day', d, { memberId: 'c2' });
    expect(second.created).toBe(false);
    expect(second.graph).toBe(first.graph);
    expect(readActiveBoards(second.graph, idx).filter((b) => b.cadenceUnit === 'day')).toHaveLength(1);
  });

  it('rolls over: an EMPTY past day is removed (no junk), a day WITH content is archived', () => {
    // yesterday (empty) + day-before (with an item) + today
    let g = ensureCadenceBoard(emptyGraph(), idx, 'day', new Date(Date.UTC(2026, 5, 25)), { memberId: 'd25' }).graph;
    g = ensureCadenceBoard(g, idx, 'day', new Date(Date.UTC(2026, 5, 26)), { memberId: 'd26' }).graph;
    // put an item on the 25th so it has content
    g = placeItem(g, boardRootRef(cadenceBoardId('day', '2026-06-25')), { memberId: 'note25', nodeRef: itemRef('day-2026-06-25', 'i'), kind: 'note', x: 0, y: 0 });
    const today = new Date(Date.UTC(2026, 5, 27));
    g = ensureCadenceBoard(g, idx, 'day', today, { memberId: 'd27' }).graph;
    expect(readActiveBoards(g, idx).filter((b) => b.cadenceUnit === 'day')).toHaveLength(3);

    g = archiveStaleCadenceBoards(g, idx, 'day', cadenceBucket('day', today), 1);
    const active = readActiveBoards(g, idx).filter((b) => b.cadenceUnit === 'day');
    const archived = readArchivedBoards(g, idx).filter((b) => b.cadenceUnit === 'day');
    // today stays active; the 25th (has content) is archived; the 26th (empty) is gone
    expect(active.map((b) => b.bucketKey)).toEqual(['2026-06-27']);
    expect(archived.map((b) => b.bucketKey)).toEqual(['2026-06-25']);
    expect(hasBoard(g, idx, cadenceBoardId('day', '2026-06-26'))).toBe(false);
  });

  it('keepActive keeps the N most-recent buckets active', () => {
    let g = emptyGraph();
    for (const day of [24, 25, 26, 27]) {
      g = ensureCadenceBoard(g, idx, 'day', new Date(Date.UTC(2026, 5, day)), { memberId: `d${day}` }).graph;
      // give each content so none vanish — we want to test the keep window, not removal
      g = placeItem(g, boardRootRef(cadenceBoardId('day', `2026-06-${day}`)), { memberId: `n${day}`, nodeRef: itemRef(`day-2026-06-${day}`, 'i'), kind: 'note', x: 0, y: 0 });
    }
    g = archiveStaleCadenceBoards(g, idx, 'day', '2026-06-27', 2);
    const active = readActiveBoards(g, idx).filter((b) => b.cadenceUnit === 'day').map((b) => b.bucketKey).sort();
    expect(active).toEqual(['2026-06-26', '2026-06-27']); // current + 1 most-recent older
  });

  it('never touches manual (non-cadence) boards', () => {
    let g = addBoard(emptyGraph(), idx, { memberId: 'master', boardId: 'vision-board', title: 'Vision Board' });
    g = ensureCadenceBoard(g, idx, 'day', new Date(Date.UTC(2026, 5, 20)), { memberId: 'old' }).graph;
    g = ensureCadenceBoard(g, idx, 'day', new Date(Date.UTC(2026, 5, 27)), { memberId: 'today' }).graph;
    g = archiveStaleCadenceBoards(g, idx, 'day', '2026-06-27', 1);
    // the manual master board is still active regardless of cadence rollover
    expect(readActiveBoards(g, idx).some((b) => b.boardId === 'vision-board')).toBe(true);
  });
});

describe('rich note content (html body + plain projection)', () => {
  it('persists an html body and its plain-text projection, readable on the item', () => {
    let g = placeItem(emptyGraph(), root, { memberId: 'n1', nodeRef: itemRef(BOARD, 'i1'), kind: 'note', x: 0, y: 0, text: 'plain' });
    // legacy plain note: html absent, text present
    expect(readItems(g, root)[0].html).toBeUndefined();
    expect(readItems(g, root)[0].text).toBe('plain');
    // rich edit commits html + derived plain projection
    g = patchItem(g, root, 'n1', { html: '<b>Bold</b><br>line two', text: 'Bold\nline two' });
    const item = readItems(g, root)[0];
    expect(item.html).toBe('<b>Bold</b><br>line two');
    expect(item.text).toBe('Bold\nline two'); // plain projection drives previews/search
    expect(item.kind).toBe('note'); // still a note — no new kind, backward compatible
  });
});

describe('item resize (persisted w/h, clamped to a usable minimum)', () => {
  it('resizes an item and clamps below the minimum', () => {
    let g = placeItem(emptyGraph(), root, { memberId: 'r1', nodeRef: itemRef(BOARD, 'i'), kind: 'note', x: 0, y: 0 });
    g = resizeItem(g, root, 'r1', 400, 300);
    expect(readItems(g, root)[0].w).toBe(400);
    expect(readItems(g, root)[0].h).toBe(300);
    g = resizeItem(g, root, 'r1', 10, 10); // below the floor → clamped, never tiny
    expect(readItems(g, root)[0].w).toBe(MIN_ITEM_W);
    expect(readItems(g, root)[0].h).toBe(MIN_ITEM_H);
  });
});

describe('readPlaceableSurface (the live-surface item DATA reader)', () => {
  const asItem = (extra: unknown) => ({ memberId: 'm', kind: 'note', x: 0, y: 0, w: 100, h: 100, extra } as any);

  it('returns the name pair + surfaceInput for a valid placeable-surface item', () => {
    const ref = readPlaceableSurface(
      asItem({ placeableSurface: { packageName: 'visual-database', entryName: 'visual-database', surfaceInput: { subject: 'x' } } }),
    );
    expect(ref).toEqual({ packageName: 'visual-database', entryName: 'visual-database', surfaceInput: { subject: 'x' } });
  });

  it('surfaceInput is optional (absent → undefined, still valid)', () => {
    const ref = readPlaceableSurface(asItem({ placeableSurface: { packageName: 'chat', entryName: 'chat' } }));
    expect(ref).toEqual({ packageName: 'chat', entryName: 'chat', surfaceInput: undefined });
  });

  it('returns null for a normal note (no placeableSurface) so it renders as a note', () => {
    expect(readPlaceableSurface(asItem({ locked: true }))).toBeNull();
    expect(readPlaceableSurface(asItem(undefined))).toBeNull();
  });

  it('returns null for a malformed ref (missing/empty/non-string name) — never a broken mount', () => {
    expect(readPlaceableSurface(asItem({ placeableSurface: { entryName: 'e' } }))).toBeNull();
    expect(readPlaceableSurface(asItem({ placeableSurface: { packageName: '', entryName: 'e' } }))).toBeNull();
    expect(readPlaceableSurface(asItem({ placeableSurface: { packageName: 'p', entryName: 42 } }))).toBeNull();
    expect(readPlaceableSurface(asItem({ placeableSurface: 'not-an-object' }))).toBeNull();
  });
});

function keyOf(bytes: Uint8Array): string {
  return Array.from(bytes).join(',');
}

describe('duplicateBoard — carries the WHOLE board look profile (bug: appearance was dropped)', () => {
  it('a duplicated board inherits background + gridSnap + #225 appearance defaults', () => {
    const idx = boardIndexRef('vb');
    let g = addBoard(emptyGraph(), idx, { memberId: 'm-src', boardId: 'SRC', title: 'Source' });
    // give the source a full look profile
    g = setBoardBackground(g, idx, 'm-src', 'dots');
    g = setBoardGridSnap(g, idx, 'm-src', true);
    g = applyAppearanceProfileToBoard(g, idx, 'm-src', { containerVariant: 'panel', padding: 'lg' });

    g = duplicateBoard(g, idx, { srcBoardId: 'SRC', newBoardId: 'DUP', newMemberId: 'm-dup', title: 'Copy', mint: (() => { let n = 0; return () => `d${n++}`; })() });

    const dup = readBoards(g, idx).find((b) => b.boardId === 'DUP')!;
    expect(dup.title).toBe('Copy'); // its OWN identity
    expect(dup.archived).toBe(false); // a copy is active
    expect(dup.background).toBe('dots'); // look carried
    expect(dup.gridSnap).toBe(true); // look carried
    expect(dup.appearance).toEqual({ containerVariant: 'panel', padding: 'lg' }); // #225 look carried (was dropped before)
  });

  it('carryBoardLook is a no-op for an undefined source and copies nothing identity-level', () => {
    const idx = boardIndexRef('vb');
    let g = addBoard(emptyGraph(), idx, { memberId: 'm-dst', boardId: 'DST', title: 'Dest' });
    const before = readBoards(g, idx).find((b) => b.boardId === 'DST')!;
    g = carryBoardLook(g, idx, undefined, 'm-dst');
    const after = readBoards(g, idx).find((b) => b.boardId === 'DST')!;
    expect(after).toEqual(before); // undefined source → unchanged
  });
});
