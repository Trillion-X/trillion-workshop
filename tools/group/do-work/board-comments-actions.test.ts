// Proof for the comment GRAPH bridge: comments co-locate on the anchored item as extra.commentThread,
// add/resolve go through patchItem preserving other extra, connectors + furniture are never anchors.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems, patchItem } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX } from './batch-actions';
import type { CommentEntry } from '../read-data/board-comments';
import {
  addCommentToItem,
  boardCommentThreads,
  commentReviewRows,
  commentThreadOf,
  itemIsCommentAnchor,
  setItemThreadResolved,
  threadOfItem,
} from './board-comments-actions';

const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const entry = (id: string, author: string, text: string, at: number): CommentEntry => ({ id, author, text, at });

function board() {
  let g = emptyGraph();
  const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, ...a } as never));
  put({ memberId: 'n1', kind: 'note', x: 0, y: 0, text: 'idea', extra: { fill: '#fff', locked: true } });
  put({ memberId: 'n2', kind: 'note', x: 200, y: 0, text: 'plan' });
  put({ memberId: 'edge', kind: 'connector', x: 0, y: 0, extra: { fromMemberId: 'n1', toMemberId: 'n2' } });
  put({ memberId: `${AXIS_TICK_PREFIX}x:10`, kind: 'note', x: 0, y: 400, text: '10', extra: { axisTick: true } });
  return g;
}

describe('board-comments-actions — the graph bridge', () => {
  it('adding a comment stores it on the item as extra.commentThread, preserving other extra', () => {
    let g = board();
    g = addCommentToItem(g, PARENT, 'n1', entry('c1', 'Bri', 'love this', 1));
    const n1 = readItems(g, PARENT).find((it) => it.memberId === 'n1')!;
    const thread = threadOfItem(n1);
    expect(thread.entries.map((e) => e.text)).toEqual(['love this']);
    expect(thread.resolved).toBe(false);
    // other extra untouched
    expect(n1.extra.fill).toBe('#fff');
    expect(n1.extra.locked).toBe(true);
  });

  it('multiple comments accumulate; resolve hides the pin without losing history; reopen restores', () => {
    let g = board();
    g = addCommentToItem(g, PARENT, 'n1', entry('c1', 'Bri', 'first', 1));
    g = addCommentToItem(g, PARENT, 'n1', entry('c2', 'Sam', 'second', 2));
    expect(commentThreadOf(g, PARENT, 'n1').entries).toHaveLength(2);
    g = setItemThreadResolved(g, PARENT, 'n1', true);
    expect(commentThreadOf(g, PARENT, 'n1').resolved).toBe(true);
    expect(commentThreadOf(g, PARENT, 'n1').entries).toHaveLength(2); // history intact
    // a new comment on a resolved thread reopens it
    g = addCommentToItem(g, PARENT, 'n1', entry('c3', 'Bri', 'reopened', 3));
    expect(commentThreadOf(g, PARENT, 'n1').resolved).toBe(false);
    expect(commentThreadOf(g, PARENT, 'n1').entries).toHaveLength(3);
  });

  it('boardCommentThreads lists only content anchors with entries — connectors + furniture excluded', () => {
    let g = board();
    g = addCommentToItem(g, PARENT, 'n1', entry('c1', 'Bri', 'x', 1));
    g = addCommentToItem(g, PARENT, 'n2', entry('c2', 'Bri', 'y', 2));
    g = setItemThreadResolved(g, PARENT, 'n2', true); // resolved still counts as a thread (has entries)
    // even if a connector somehow carried a thread, it must never be an anchor
    g = patchItem(g, PARENT, 'edge', { commentThread: { entries: [entry('c9', 'X', 'no', 9)], resolved: false } });
    const anchored = boardCommentThreads(readItems(g, PARENT));
    expect(anchored.map((a) => a.anchorId).sort()).toEqual(['n1', 'n2']); // NOT edge, NOT the axis tick
  });

  it('itemIsCommentAnchor: content yes, connector no, furniture no', () => {
    const items = readItems(board(), PARENT);
    const byId = (id: string) => items.find((it) => it.memberId === id)!;
    expect(itemIsCommentAnchor(byId('n1'))).toBe(true);
    expect(itemIsCommentAnchor(byId('edge'))).toBe(false);
    expect(itemIsCommentAnchor(byId(`${AXIS_TICK_PREFIX}x:10`))).toBe(false);
  });

  it('an item with no thread reads EMPTY_THREAD (no pin)', () => {
    expect(commentThreadOf(board(), PARENT, 'n2').entries).toEqual([]);
    expect(commentThreadOf(board(), PARENT, 'n2').resolved).toBe(false);
  });

  it('commentReviewRows lists threads with item labels, OPEN first then most-recent', () => {
    let g = board();
    g = addCommentToItem(g, PARENT, 'n1', entry('a', 'Bri', 'older open', 100)); // open, older
    g = addCommentToItem(g, PARENT, 'n2', entry('b', 'Sam', 'newest', 300));      // open, newest
    g = setItemThreadResolved(g, PARENT, 'n1', true);                              // n1 now RESOLVED
    g = addCommentToItem(g, PARENT, 'n2', entry('c', 'Sam', 'reply', 400));        // n2 still open, newest
    const rows = commentReviewRows(readItems(g, PARENT));
    expect(rows.map((r) => r.anchorId)).toEqual(['n2', 'n1']); // n2 open first; n1 resolved after
    expect(rows[0].label).toBe('plan'); // n2's item text
    expect(rows[1].label).toBe('idea'); // n1's item text
    expect(rows[0].summary.open).toBe(true);
    expect(rows[1].summary.resolved).toBe(true);
  });

  it('commentReviewRows is empty on a board with no threads', () => {
    expect(commentReviewRows(readItems(board(), PARENT))).toEqual([]);
  });
});
