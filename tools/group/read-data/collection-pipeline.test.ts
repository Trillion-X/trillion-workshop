// End-to-end proof of the save-selection-as-collection -> apply-collection loop:
// selection -> selectionToTemplate (BoardTemplate) -> saveCollection -> readActive ->
// applyTemplate places the saved stack onto a NEW board. This is the real user loop
// the CollectionSaveButton + collection picker run, proven before wiring (L116).

import { describe, it, expect } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { selectionToTemplate } from './selection-to-template';
import { applyTemplate } from './board-template-apply';
import {
  boardIndexRef,
  boardRootRef,
  itemIsConnector,
  readBoards,
  readItems,
} from './group-board-model';
import {
  collectionIndexRef,
  saveCollection,
  readActiveCollections,
  getCollection,
} from './collection-store';

function mintSeq() {
  let n = 0;
  return () => `m${n++}`;
}

describe('collection pipeline — selection -> save -> apply (real user loop)', () => {
  it('saves a 3-item selection with a connector, then applies it onto a fresh board', () => {
    // A realistic board: 3 items at scattered positions + 1 connector a -> c.
    const sourceItems = [
      { memberId: 'a', kind: 'note', x: 100, y: 100, w: 200, h: 140, text: 'idea A' },
      { memberId: 'b', kind: 'note', x: 400, y: 100, w: 200, h: 140, text: 'idea B' },
      { memberId: 'c', kind: 'stamp', x: 100, y: 400, w: 120, h: 120, text: '\u{1F525}' },
    ];
    const sourceConnectors = [
      { memberId: 'x', fromId: 'a', toId: 'c', extra: { label: 'leads to' } },
    ];
    // User selects a + c (not b).
    const selectedIds = ['a', 'c'];

    // 1. selection -> BoardTemplate
    const template = selectionToTemplate(sourceItems, sourceConnectors, selectedIds, 'My Stack', 'col-1');
    expect(template.name).toBe('My Stack');
    const itemT = template.items.filter((i) => i.kind !== 'connector');
    const connT = template.items.filter((i) => i.kind === 'connector');
    expect(itemT).toHaveLength(2); // a + c kept, b dropped
    expect(connT).toHaveLength(1); // a->c survives (both endpoints kept)
    expect(Math.min(...itemT.map((i) => i.x))).toBe(0);
    expect(Math.min(...itemT.map((i) => i.y))).toBe(0);

    // 2. save (stores the BoardTemplate) + read back
    const cidx = collectionIndexRef('vision-board');
    const gStore = saveCollection(emptyGraph(), cidx, {
      memberId: 'sm1',
      collectionId: 'col-1',
      name: 'My Stack',
      record: template,
    });
    const listed = readActiveCollections(gStore, cidx);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('My Stack');
    const stored = getCollection(gStore, cidx, 'sm1')!;
    expect(stored.record.items).toHaveLength(3); // 2 items + 1 connector TemplateItem

    // 3. apply the SAVED record onto a NEW board (a fresh board index)
    const bidx = boardIndexRef('apply-target');
    const gApplied = applyTemplate(emptyGraph(), bidx, {
      template: stored.record,
      newBoardId: 'B1',
      newMemberId: 'mem',
      mint: mintSeq(),
    });

    // The new board exists.
    expect(readBoards(gApplied, bidx).map((b) => b.boardId)).toContain('B1');

    // The placed board carries both items + the resolved connector.
    const placed = readItems(gApplied, boardRootRef('B1'));
    const placedItems = placed.filter((i) => !itemIsConnector(i));
    const placedConnectors = placed.filter((i) => itemIsConnector(i));
    expect(placedItems).toHaveLength(2); // note A + stamp
    expect(placedConnectors).toHaveLength(1); // the a->c connector

    // The saved item content survived apply (the stamp glyph is there).
    const stamp = placedItems.find((i) => i.kind === 'stamp')!;
    expect(stamp.text).toBe('\u{1F525}');

    // The connector was remapped to the MINTED member ids of the placed items,
    // not left dangling at the template-local ids 'a'/'c'.
    const noteA = placedItems.find((i) => i.text === 'idea A')!;
    const conn = placedConnectors[0];
    expect(conn.extra.fromMemberId).toBe(noteA.memberId);
    expect(conn.extra.toMemberId).toBe(stamp.memberId);
    expect(conn.extra.fromMemberId).not.toBe('a');
    expect(conn.extra.toMemberId).not.toBe('c');
  });

  it('drops a connector whose endpoint is not selected, all the way to the applied board', () => {
    const items = [
      { memberId: 'a', kind: 'note', x: 0, y: 0, w: 100, h: 100 },
      { memberId: 'b', kind: 'note', x: 200, y: 0, w: 100, h: 100 },
    ];
    const connectors = [{ memberId: 'x', fromId: 'b', toId: 'a' }];
    const template = selectionToTemplate(items, connectors, ['a'], 'Solo', 'c2');
    expect(template.items.filter((i) => i.kind === 'connector')).toHaveLength(0);

    const cidx = collectionIndexRef();
    const gStore = saveCollection(emptyGraph(), cidx, { memberId: 'sm', collectionId: 'c2', name: 'Solo', record: template });
    const stored = getCollection(gStore, cidx, 'sm')!;

    const bidx = boardIndexRef('apply-target');
    const gApplied = applyTemplate(emptyGraph(), bidx, { template: stored.record, newBoardId: 'B2', newMemberId: 'mem', mint: mintSeq() });
    const placed = readItems(gApplied, boardRootRef('B2'));
    expect(placed.filter((i) => itemIsConnector(i))).toHaveLength(0);
    expect(placed.filter((i) => !itemIsConnector(i))).toHaveLength(1);
  });

  it('an empty selection saves an empty (but valid, named) collection that applies to an empty board', () => {
    const template = selectionToTemplate([], [], [], 'Empty', 'c3');
    expect(template.items).toHaveLength(0);
    const cidx = collectionIndexRef();
    const gStore = saveCollection(emptyGraph(), cidx, { memberId: 'sm', collectionId: 'c3', name: 'Empty', record: template });
    const listed = readActiveCollections(gStore, cidx);
    expect(listed).toHaveLength(1);
    expect(listed[0].record.items).toHaveLength(0);

    const bidx = boardIndexRef('apply-target');
    const gApplied = applyTemplate(emptyGraph(), bidx, { template: listed[0].record, newBoardId: 'B3', newMemberId: 'mem', mint: mintSeq() });
    expect(readBoards(gApplied, bidx).map((b) => b.boardId)).toContain('B3');
    expect(readItems(gApplied, boardRootRef('B3'))).toHaveLength(0);
  });
});
