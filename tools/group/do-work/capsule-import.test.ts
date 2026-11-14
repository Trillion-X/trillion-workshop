// packages/group/do-work/capsule-import.test.ts
//
// R12 receive side: importing a shared capsule onto the CURRENT board rides the SAME clone
// pipeline as copy/paste/duplicate. These tests drive the whole chain
//   capsuleBoardToClipboard → clipboardToDrafts → planPaste
// and assert the clone invariants: fresh ids, internal connector re-anchored to the NEW
// node ids, dangling connector dropped, relative layout preserved at the paste origin.
import { describe, expect, it } from 'vitest';
import {
  capsuleBoardToClipboard,
  clipboardToDrafts,
  planPaste,
} from './board-clipboard';
import { buildShareCapsule, type CapsuleSource } from '../read-data/share-capsule';

/** A note + connector source board: n1 and n2 joined by a connector c1. */
function connectedSource(): CapsuleSource {
  return {
    boardId: 'b1',
    title: 'Plan',
    scope: { kind: 'board' },
    items: [
      { memberId: 'n1', kind: 'note', x: 100, y: 100, w: 160, h: 90, text: 'A' },
      { memberId: 'n2', kind: 'note', x: 400, y: 260, w: 160, h: 90, text: 'B' },
      {
        memberId: 'c1',
        kind: 'connector',
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        extra: { fromMemberId: 'n1', toMemberId: 'n2' },
      },
    ],
  };
}

let counter = 0;
const mint = () => `m${(counter += 1)}`;

describe('capsule import — rides the copy/paste clone pipeline', () => {
  it('imports nodes with FRESH ids and re-anchors the internal connector to them', () => {
    counter = 0;
    const capsule = buildShareCapsule([connectedSource()], 'My plan');
    const board = capsule.boards[0];
    const clip = capsuleBoardToClipboard(board);
    const placements = planPaste(clipboardToDrafts(clip, 1000, 500), mint);

    const nodes = placements.filter((p) => !p.isConnector);
    const connectors = placements.filter((p) => p.isConnector);
    expect(nodes).toHaveLength(2);
    expect(connectors).toHaveLength(1);

    // None of the fresh ids collide with the original capsule member ids.
    for (const p of placements) expect(['n1', 'n2', 'c1']).not.toContain(p.memberId);

    // The connector points at the NEW node ids (not the stale n1/n2).
    const byLocal = new Map(nodes.map((n) => [n.localId, n.memberId]));
    expect(connectors[0].extra).toMatchObject({
      fromMemberId: byLocal.get('n1'),
      toMemberId: byLocal.get('n2'),
    });
  });

  it('preserves relative layout, anchored at the paste origin', () => {
    counter = 0;
    const capsule = buildShareCapsule([connectedSource()], 'My plan');
    const clip = capsuleBoardToClipboard(capsule.boards[0]);
    const drafts = clipboardToDrafts(clip, 1000, 500).filter((d) => !d.fromLocalId);
    // n1 was at (100,100), n2 at (400,260) → bounding-box origin (100,100). At paste
    // origin (1000,500): n1 → (1000,500), n2 → (1300,660). Relative gap (300,160) intact.
    const a = drafts.find((d) => d.text === 'A')!;
    const b = drafts.find((d) => d.text === 'B')!;
    expect([a.x, a.y]).toEqual([1000, 500]);
    expect([b.x, b.y]).toEqual([1300, 660]);
  });

  it('drops a connector whose endpoint was NOT in the shared subset (no dangle)', () => {
    counter = 0;
    // A board carrying n1 + a connector whose other end (n2) is absent from the shared set.
    // Even under whole-'board' scope the adapter must drop the connector — it cannot be
    // re-anchored — leaving just n1's clone.
    const partial: CapsuleSource = {
      boardId: 'b1',
      title: 'Partial',
      scope: { kind: 'board' },
      items: [
        { memberId: 'n1', kind: 'note', x: 100, y: 100, w: 160, h: 90, text: 'A' },
        { memberId: 'c1', kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'n1', toMemberId: 'n2' } },
      ],
    };
    const capsule = buildShareCapsule([partial], 'Partial');
    const clip = capsuleBoardToClipboard(capsule.boards[0]);
    const placements = planPaste(clipboardToDrafts(clip, 0, 0), mint);
    expect(placements.filter((p) => p.isConnector)).toHaveLength(0);
    expect(placements.filter((p) => !p.isConnector)).toHaveLength(1); // just n1's clone
  });

  it('empty board → empty bundle → no placements', () => {
    const clip = capsuleBoardToClipboard({ boardId: 'x', title: 'Empty', items: [] });
    expect(clip.items).toHaveLength(0);
    expect(planPaste(clipboardToDrafts(clip, 0, 0), mint)).toHaveLength(0);
  });
});
