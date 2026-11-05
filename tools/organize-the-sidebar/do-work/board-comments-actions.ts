// packages/group/do-work/board-comments-actions.ts
//
// The GRAPH bridge for the anchored-thread primitive (read-data/board-comments): extract every board
// item's thread as self-describing DATA, and mutate a single anchor's thread through the ONE tested
// `patchItem` write path. A comment thread lives ON the anchored item as `extra.commentThread` (the
// presentation IS the extra, so it co-locates with the item — it moves when the item moves and is
// deleted when the item is deleted, for free). Connectors + auto furniture (region headings, axis
// ticks, lane headers) are never comment anchors — you annotate CONTENT, not the board's own scaffolding.

import type { GroupGraph, AddressRef } from '../../ui/show/group/group-graph';
import type { BoardItem } from '../read-data/group-board-model.ts';
import { readItems, patchItem, itemIsConnector } from '../read-data/group-board-model.ts';
import { itemIsBoardFurniture } from './batch-actions.ts';
import {
  type AnchoredThread,
  type CommentEntry,
  type CommentThread,
  type ThreadSummary,
  EMPTY_THREAD,
  appendEntry,
  setResolved,
  threadFromRaw,
  threadSummary,
} from '../read-data/board-comments.ts';

/** An item is a comment ANCHOR iff it is real content (a note/frame/image/…), not a connector or furniture. */
export function itemIsCommentAnchor(item: BoardItem): boolean {
  return !itemIsConnector(item) && !itemIsBoardFurniture(item);
}

/** The normalized thread on one item (EMPTY_THREAD when it has none / a malformed value). */
export function threadOfItem(item: BoardItem): CommentThread {
  return threadFromRaw(item.extra?.commentThread) ?? EMPTY_THREAD;
}

/** Every anchored thread on the board — content items that carry a real thread, as `{anchorId, thread}`. */
export function boardCommentThreads(items: readonly BoardItem[]): AnchoredThread[] {
  const out: AnchoredThread[] = [];
  for (const item of items) {
    if (!itemIsCommentAnchor(item)) continue;
    const thread = threadFromRaw(item.extra?.commentThread);
    if (thread && thread.entries.length > 0) out.push({ anchorId: item.memberId, thread });
  }
  return out;
}

/** Read one item's thread from the live graph (EMPTY_THREAD if absent). */
export function commentThreadOf(graph: GroupGraph, ref: AddressRef, memberId: string): CommentThread {
  const item = readItems(graph, ref).find((it) => it.memberId === memberId);
  return item ? threadOfItem(item) : EMPTY_THREAD;
}

/**
 * Add a comment to an item's thread (creating the thread on first comment) and return the new graph.
 * The entry is INJECTED (id + timestamp supplied by the caller/shell → pure + deterministic). The
 * thread is written back through `patchItem`, which merges into the item's presentation, so every
 * other `extra` field (fill, lock, marker, …) is preserved untouched.
 */
export function addCommentToItem(
  graph: GroupGraph,
  ref: AddressRef,
  memberId: string,
  entry: CommentEntry,
): GroupGraph {
  const next = appendEntry(commentThreadOf(graph, ref, memberId), entry);
  return patchItem(graph, ref, memberId, { commentThread: next });
}

/** One row of the comments review panel: the anchor + a human label + its thread summary. */
export interface CommentReviewRow {
  readonly anchorId: string;
  readonly label: string;
  readonly summary: ThreadSummary;
}

/**
 * The review-panel rows: every board thread as `{anchorId, label, summary}`, OPEN threads first, then
 * by most-recent activity (last entry timestamp) descending. The label is the anchor item's own text
 * (trimmed, else a short id) so the reviewer recognizes what a thread is about. Pure read-model over
 * the same `boardCommentThreads` — the DATA behind a "triage all comments + jump to each" side panel.
 */
export function commentReviewRows(items: readonly BoardItem[]): CommentReviewRow[] {
  const byId = new Map(items.map((it) => [it.memberId, it]));
  const label = (id: string): string => {
    const t = byId.get(id)?.text;
    const trimmed = typeof t === 'string' ? t.trim() : '';
    return trimmed !== '' ? trimmed : id;
  };
  return boardCommentThreads(items)
    .map((a): CommentReviewRow => ({ anchorId: a.anchorId, label: label(a.anchorId), summary: threadSummary(a.thread) }))
    .sort((x, y) => {
      const xo = x.summary.open ? 1 : 0;
      const yo = y.summary.open ? 1 : 0;
      if (xo !== yo) return yo - xo; // open threads first
      return (y.summary.lastAt ?? 0) - (x.summary.lastAt ?? 0); // then most-recent first
    });
}

/** Resolve (or reopen) an item's thread — hides/shows its pin without losing any history. */
export function setItemThreadResolved(
  graph: GroupGraph,
  ref: AddressRef,
  memberId: string,
  resolved: boolean,
): GroupGraph {
  const next = setResolved(commentThreadOf(graph, ref, memberId), resolved);
  return patchItem(graph, ref, memberId, { commentThread: next });
}
