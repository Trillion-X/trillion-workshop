// Proof for the anchored-thread primitive: normalize fail-closed, append reopens, resolve keeps
// history, and the collection reducers drive the badge/panel counts.
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  type CommentEntry,
  EMPTY_THREAD,
  appendEntry,
  openThreads,
  setResolved,
  threadFromRaw,
  threadIsEmpty,
  threadIsOpen,
  threadSummary,
  totalOpenComments,
  totalThreads,
} from '../../../read-data/board-comments.ts';

const entry = (id: string, author: string, text: string, at: number): CommentEntry => ({ id, author, text, at });

describe('board-comments — the anchored-thread primitive', () => {
  it('threadFromRaw is fail-closed: non-thread → null, malformed entries dropped, resolved coerced', () => {
    expect(threadFromRaw(undefined)).toBeNull();
    expect(threadFromRaw('nope')).toBeNull();
    expect(threadFromRaw({ resolved: true })).toBeNull(); // no entries array
    const t = threadFromRaw({ entries: [entry('a', 'Bri', 'hi', 1), { id: 'b' }, null, 5], resolved: 'yes' });
    expect(t).not.toBeNull();
    expect(t!.entries.map((e) => e.id)).toEqual(['a']); // the two malformed entries dropped
    expect(t!.resolved).toBe(false); // 'yes' is not boolean true → false
  });

  it('a NaN/Infinity timestamp is dropped — no phantom open thread with a NaN lastAt', () => {
    // typeof NaN === 'number' is true, so a non-finite `at` must be rejected explicitly or it would keep the
    // thread falsely "open" and poison threadSummary().lastAt with NaN.
    const t = threadFromRaw({ entries: [{ id: 'c1', author: 'A', text: 'x', at: Number.NaN }], resolved: false });
    expect(t!.entries).toEqual([]); // the NaN-timestamped entry is not a valid comment
    expect(threadIsOpen(t!)).toBe(false); // no entries -> not open
    const t2 = threadFromRaw({ entries: [{ id: 'c2', author: 'A', text: 'y', at: Infinity }], resolved: false });
    expect(t2!.entries).toEqual([]);
  });

  it('appendEntry adds the entry and REOPENS a resolved thread', () => {
    const resolved = setResolved({ entries: [entry('a', 'Bri', 'first', 1)], resolved: true }, true);
    expect(resolved.resolved).toBe(true);
    const next = appendEntry(resolved, entry('b', 'Sam', 'reply', 2));
    expect(next.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(next.resolved).toBe(false); // a new comment reactivates the discussion
  });

  it('setResolved hides the pin but never loses history', () => {
    const t = { entries: [entry('a', 'Bri', 'x', 1), entry('b', 'Bri', 'y', 2)], resolved: false };
    const done = setResolved(t, true);
    expect(done.resolved).toBe(true);
    expect(done.entries).toHaveLength(2); // history intact
    expect(threadIsOpen(done)).toBe(false);
    expect(threadIsOpen(setResolved(done, false))).toBe(true); // reopen shows the pin again
  });

  it('open/empty predicates gate the pin correctly', () => {
    expect(threadIsEmpty(EMPTY_THREAD)).toBe(true);
    expect(threadIsOpen(EMPTY_THREAD)).toBe(false); // no entries → no pin
    const open = { entries: [entry('a', 'Bri', 'x', 1)], resolved: false };
    expect(threadIsOpen(open)).toBe(true);
    expect(threadIsEmpty(open)).toBe(false);
  });

  it('threadSummary reports count + last author/preview/timestamp', () => {
    const s = threadSummary({ entries: [entry('a', 'Bri', 'first', 1), entry('b', 'Sam', 'latest word', 9)], resolved: false });
    expect(s).toMatchObject({ count: 2, resolved: false, open: true, lastAuthor: 'Sam', lastAt: 9, preview: 'latest word' });
    const empty = threadSummary(EMPTY_THREAD);
    expect(empty).toMatchObject({ count: 0, lastAuthor: null, preview: null, lastAt: null });
  });

  it('collection reducers drive the badge + panel counts (open-only)', () => {
    const anchored = [
      { anchorId: 'n1', thread: { entries: [entry('a', 'Bri', 'x', 1), entry('b', 'Bri', 'y', 2)], resolved: false } },
      { anchorId: 'n2', thread: { entries: [entry('c', 'Sam', 'z', 3)], resolved: true } }, // resolved → not open
      { anchorId: 'n3', thread: EMPTY_THREAD }, // empty → neither
    ];
    expect(openThreads(anchored).map((a) => a.anchorId)).toEqual(['n1']);
    expect(totalOpenComments(anchored)).toBe(2); // n1's two entries
    expect(totalThreads(anchored)).toBe(2); // n1 + n2 carry entries; n3 empty
  });
});

describe('board-comments — hostile extra.commentThread.entries is capped (cont.98 batch-20)', () => {
  it('a million-entry thread is capped to <= 1024', () => {
    const entries = Array.from({ length: 1_000_000 }, (_, i) => ({ id: `e${i}`, author: 'a', text: 't', at: i + 1 }));
    const thread = threadFromRaw({ entries, resolved: false });
    expect(thread).not.toBeNull();
    expect(thread!.entries.length).toBe(1024);
  });
  it('a non-thread shape still returns null; a normal thread is unchanged', () => {
    expect(threadFromRaw({ nope: 1 })).toBeNull();
    const ok = threadFromRaw({ entries: [{ id: 'e1', author: 'me', text: 'hi', at: 5 }], resolved: false });
    expect(ok!.entries.length).toBe(1);
    expect(threadSummary(ok!).count).toBe(1);
  });
});
