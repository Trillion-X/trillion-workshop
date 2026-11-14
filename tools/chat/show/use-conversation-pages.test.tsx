// PORTED FROM: bitfield-packages/packages/chat/show/use-conversation-pages.test.tsx @ e99ac5976
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../do-work/read-chat-conversation-page', () => ({ readChatConversationPage: vi.fn() }));
import { readChatConversationPage } from '../do-work/read-chat-conversation-page';
import { decodeChatSessionsFeed } from '../read-data/read-chat-sessions';
import type { ChatConversationPageCursor } from '../read-data/read-chat-sessions';
import { useConversationPages } from './use-conversation-pages';
const head = { content_hash: `1f:${'a'.repeat(64)}`, offset: 0 };
const second = { ...head, offset: 64 };
const rows = (...ids: string[]) => decodeChatSessionsFeed(ids.map(recordId => ({ recordId })));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('conversation list continuation', () => {
  it.each([null, { ...head, content_hash: `1f:${'b'.repeat(64)}` }])('hides prior head rows in the first committed render for %j', async nextHead => {
    vi.mocked(readChatConversationPage).mockResolvedValueOnce({ rows: rows('old-scope'), next_cursor: second, has_more: true });
    const commits: Array<{ head: string | null; ids: string[] }> = [];
    const { result, rerender } = renderHook(({ cursor }: { cursor: ChatConversationPageCursor | null }) => {
      const page = useConversationPages(cursor, false);
      useLayoutEffect(() => { commits.push({ head: cursor?.content_hash ?? null, ids: page.rows.map(row => row.recordId) }); });
      return page;
    }, { initialProps: { cursor: head as ChatConversationPageCursor | null } });
    await act(() => result.current.loadOlder());
    expect(result.current.rows[0].recordId).toBe('old-scope');
    commits.length = 0;
    rerender({ cursor: nextHead });
    expect(commits[0]).toEqual({ head: nextHead?.content_hash ?? null, ids: [] });
    expect(result.current.rows).toEqual([]);
  });
  it('deduplicates pages and retries the same cursor after failure', async () => {
    vi.mocked(readChatConversationPage)
      .mockResolvedValueOnce({ rows: rows('first'), next_cursor: second, has_more: true })
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValueOnce({ rows: rows('first', 'second'), next_cursor: null, has_more: false });
    const { result } = renderHook(() => useConversationPages(head, false));
    await act(() => result.current.loadOlder());
    await act(() => result.current.loadOlder());
    expect(result.current.error).toBe(true);
    expect(result.current.rows.map(r => r.recordId)).toEqual(['first']);
    expect(result.current.hasMore).toBe(true);
    await act(() => result.current.loadOlder());
    expect(readChatConversationPage).toHaveBeenNthCalledWith(3, second, expect.any(AbortSignal));
    expect(result.current.rows.map(r => r.recordId)).toEqual(['first', 'second']);
    expect(result.current.hasMore).toBe(false);
  });
  it('ignores an old request after the published head changes', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof readChatConversationPage>>) => void;
    vi.mocked(readChatConversationPage).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { result, rerender } = renderHook(({ cursor }) => useConversationPages(cursor, false), { initialProps: { cursor: head } });
    let pending!: Promise<void>;
    act(() => { pending = result.current.loadOlder(); });
    act(() => rerender({ cursor: { ...head, content_hash: `1f:${'b'.repeat(64)}` } }));
    await act(async () => { resolve({ rows: rows('stale'), next_cursor: null, has_more: false }); await pending; });
    expect(result.current.rows).toEqual([]);
    expect(result.current.hasMore).toBe(true);
  });
  it('refuses a repeated cursor without advancing or duplicating the request', async () => {
    vi.mocked(readChatConversationPage).mockResolvedValue({ rows: rows('bad'), next_cursor: head, has_more: true });
    const { result } = renderHook(() => useConversationPages(head, false));
    await act(async () => { await Promise.all([result.current.loadOlder(), result.current.loadOlder()]); });
    expect(readChatConversationPage).toHaveBeenCalledOnce();
    expect(result.current.rows).toEqual([]);
    await waitFor(() => expect(result.current.error).toBe(true));
  });
});
