// packages/group/read-data/connect-new-note.test.ts
//
// #159: `connectNewNote` is the PURE graph transform behind the mind-map quick-create
// gesture (drag a connector off an item into empty space → a new connected note). It
// composes placeItem(note) + placeItem(connector) with INJECTED ids, so it is deterministic
// and testable with zero DOM/gesture. Proves: the note lands at (x,y) with its text, the
// connector links source→new note via extra.from/toMemberId, and the input graph is unmutated.

import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, readItems, connectNewNote } from './group-board-model';

const BOARD = 'vision-board';
const root = boardRootRef(BOARD);

const ids = {
  noteMemberId: 'm-new',
  noteItemId: 'i-new',
  connectorMemberId: 'c-new',
  connectorItemId: 'i-conn',
};

describe('#159 connectNewNote — drag-off-to-spawn-a-connected-note (pure)', () => {
  it('spawns a note at (x,y) AND a connector source→new-note', () => {
    // A board with one existing source item.
    const base = placeItem(emptyGraph(), root, { memberId: 'src', nodeRef: itemRef(BOARD, 'i-src'), kind: 'note', x: 0, y: 0 });
    const { graph, noteMemberId } = connectNewNote(base, root, {
      boardId: BOARD, fromMemberId: 'src', x: 320, y: 180, text: 'child', ...ids,
    });
    expect(noteMemberId).toBe('m-new');

    const items = readItems(graph, root);
    const note = items.find((i) => i.memberId === 'm-new');
    const conn = items.find((i) => i.memberId === 'c-new');

    // The new note: at the release point, carrying the text, of kind note.
    expect(note).toBeTruthy();
    expect(note!.kind).toBe('note');
    expect(note!.x).toBe(320);
    expect(note!.y).toBe(180);
    expect(note!.text).toBe('child');

    // The connector: a connector member linking the source to the NEW note.
    expect(conn).toBeTruthy();
    expect(conn!.kind).toBe('connector');
    expect(conn!.extra?.fromMemberId).toBe('src');
    expect(conn!.extra?.toMemberId).toBe('m-new');
  });

  it('rounds the placement point and defaults empty text', () => {
    const { graph } = connectNewNote(emptyGraph(), root, {
      boardId: BOARD, fromMemberId: 'src', x: 12.7, y: -4.2, ...ids,
    });
    const note = readItems(graph, root).find((i) => i.memberId === 'm-new');
    expect(note!.x).toBe(13);
    expect(note!.y).toBe(-4);
    expect(note!.text ?? '').toBe('');
  });

  it('is pure — never mutates the input graph', () => {
    const base = placeItem(emptyGraph(), root, { memberId: 'src', nodeRef: itemRef(BOARD, 'i-src'), kind: 'note', x: 0, y: 0 });
    const snapshot = JSON.stringify(base);
    connectNewNote(base, root, { boardId: BOARD, fromMemberId: 'src', x: 100, y: 100, ...ids });
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
