// packages/group/read-data/board-comments.ts
//
// The ANCHORED-THREAD primitive: a thread of authored entries attached to an anchor. This ONE blind
// engine yields, from DATA alone, every board-comment feature — a comment pin on any note/frame, a
// resolvable discussion, an unresolved-count badge, a "comments" side panel, a board-level note (the
// anchor is just an id) — with zero per-feature code (L069/L090). The leaf is pure and deterministic:
// entry ids + timestamps are INJECTED by the caller (the gesture shell / a test supplies them), so no
// clock lives here. Threads travel as self-describing DATA on the anchor (`extra.commentThread`); this
// leaf reads/normalizes/reduces that DATA and never touches the graph — the do-work bridge does.

/** One authored message in a thread. `at` is an injected monotonic timestamp (ms); the leaf never reads a clock. */
export interface CommentEntry {
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly at: number;
}

/** A thread anchored to something: its ordered entries + whether the discussion is resolved. */
export interface CommentThread {
  readonly entries: readonly CommentEntry[];
  readonly resolved: boolean;
}

/** A thread bound to an anchor id (an item memberId, a section, or the board root — all just ids). */
export interface AnchoredThread {
  readonly anchorId: string;
  readonly thread: CommentThread;
}

/** A summary readout for a pin badge / list row — the DATA behind every comment surface. */
export interface ThreadSummary {
  readonly count: number;
  readonly resolved: boolean;
  readonly open: boolean;
  readonly lastAuthor: string | null;
  readonly lastAt: number | null;
  readonly preview: string | null;
}

/** The canonical empty thread — an anchor with no discussion (renders no pin, no badge). */
export const EMPTY_THREAD: CommentThread = { entries: [], resolved: false };

function isCommentEntry(raw: unknown): raw is CommentEntry {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  // `at` must be a FINITE timestamp: `typeof NaN === 'number'` is true, so a NaN/Infinity `at` would slip in
  // and poison threadSummary().lastAt (NaN) while keeping the thread falsely "open" (SP5/fail-closed).
  return typeof e.id === 'string' && typeof e.author === 'string' && typeof e.text === 'string' && Number.isFinite(e.at);
}

/**
 * Normalize opaque DATA into a {@link CommentThread}, fail-closed. Accepts anything with an `entries`
 * array (malformed entries are dropped, never crash the board), coerces `resolved` to a boolean.
 * Returns `null` when the value is not a thread shape at all (so an item with no `commentThread` has
 * no thread) — self-describing DATA + a generic reader (L090), the pin/badge/panel never parse by hand.
 */
/** Max entries kept from one anchor's `extra.commentThread.entries` — a guardrail against a paste-bombed/
 *  corrupted persisted value (an uncapped million-entry array is re-filtered every read across the review
 *  panel + per-item badges), NOT a feature cap. A real discussion is a handful of messages. */
const MAX_THREAD_ENTRIES = 1024;
/** Hard scan bound so an all-junk bomb (which never fills the keep cap) is still O(1) work. */
const MAX_THREAD_SCAN = 8192;

export function threadFromRaw(raw: unknown): CommentThread | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (!Array.isArray(t.entries)) return null;
  const entries: CommentEntry[] = [];
  const scanEnd = Math.min(t.entries.length, MAX_THREAD_SCAN);
  for (let i = 0; i < scanEnd && entries.length < MAX_THREAD_ENTRIES; i += 1) {
    const e = t.entries[i];
    if (isCommentEntry(e)) entries.push(e);
  }
  return { entries, resolved: t.resolved === true };
}

/** A thread is "open" (needs attention → shows a pin) when it has entries and is not resolved. */
export function threadIsOpen(thread: CommentThread): boolean {
  return thread.entries.length > 0 && !thread.resolved;
}

/** A thread is "empty" (no discussion at all → the anchor carries no pin). */
export function threadIsEmpty(thread: CommentThread): boolean {
  return thread.entries.length === 0;
}

/**
 * Append an entry to a thread — and REOPEN it (a new comment reactivates a resolved discussion, the
 * universal thread convention). Pure: the caller injects the entry (with its id + timestamp).
 */
export function appendEntry(thread: CommentThread, entry: CommentEntry): CommentThread {
  return { entries: [...thread.entries, entry], resolved: false };
}

/** Mark a thread resolved (or reopen it). Entries are never lost — resolving hides the pin, not the history. */
export function setResolved(thread: CommentThread, resolved: boolean): CommentThread {
  return { entries: thread.entries, resolved };
}

/** The summary readout for one thread (badge count, last author/preview for a list row). */
export function threadSummary(thread: CommentThread): ThreadSummary {
  const last = thread.entries.length > 0 ? thread.entries[thread.entries.length - 1] : null;
  return {
    count: thread.entries.length,
    resolved: thread.resolved,
    open: threadIsOpen(thread),
    lastAuthor: last ? last.author : null,
    lastAt: last ? last.at : null,
    preview: last ? last.text : null,
  };
}

/** The open threads across a collection — the DATA behind "N unresolved comments" + a filtered panel. */
export function openThreads(anchored: readonly AnchoredThread[]): AnchoredThread[] {
  return anchored.filter((a) => threadIsOpen(a.thread));
}

/** Total comment entries across all OPEN threads — the header badge count. */
export function totalOpenComments(anchored: readonly AnchoredThread[]): number {
  return openThreads(anchored).reduce((sum, a) => sum + a.thread.entries.length, 0);
}

/** Total threads that carry ANY entry (open or resolved) — the "all comments" count. */
export function totalThreads(anchored: readonly AnchoredThread[]): number {
  return anchored.filter((a) => !threadIsEmpty(a.thread)).length;
}
