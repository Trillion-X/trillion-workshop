// PORTED FROM: bitfield-packages/packages/chat/show/use-conversation-pages.ts @ e99ac5976
import { useCallback, useEffect, useRef, useState } from 'react';
import { readChatConversationPage } from '../do-work/read-chat-conversation-page';
import type { ChatConversationPageCursor, ChatConversationRecord } from '../read-data/read-chat-sessions';

const key = (cursor: ChatConversationPageCursor | null) => cursor ? `${cursor.content_hash}:${cursor.offset}` : '';

/** Page only retained conversation metadata; transcript paging has its own owner. */
export function useConversationPages(head: ChatConversationPageCursor | null, invalidHead: boolean) {
  const headKey = key(head);
  const [pageHead, setPageHead] = useState(headKey);
  const [rows, setRows] = useState<ChatConversationRecord[]>([]);
  const [cursor, setCursor] = useState(head);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  const currentHead = useRef(headKey);
  currentHead.current = headKey;
  const visited = useRef(new Set<string>());
  useEffect(() => {
    request.current?.abort(); request.current = null;
    setPageHead(headKey); setRows([]); setCursor(head); setLoading(false); setError(false); visited.current.clear();
    return () => { request.current?.abort(); request.current = null; };
  }, [headKey]);
  const loadOlder = useCallback(async () => {
    if (!cursor || request.current || invalidHead || pageHead !== headKey) return;
    const controller = new AbortController(); request.current = controller;
    const requestedHead = headKey, requestedKey = key(cursor);
    setLoading(true); setError(false);
    try {
      const page = await readChatConversationPage(cursor, controller.signal);
      if (controller.signal.aborted || currentHead.current !== requestedHead) return;
      const nextKey = key(page.next_cursor);
      if (nextKey && (nextKey === requestedKey || visited.current.has(nextKey))) throw new Error('Repeated conversation page');
      visited.current.add(requestedKey);
      setRows(previous => {
        const seen = new Set(previous.map(row => row.recordId));
        return [...previous, ...page.rows.filter(row => { if (seen.has(row.recordId)) return false; seen.add(row.recordId); return true; })];
      });
      setCursor(page.next_cursor);
    } catch {
      if (!controller.signal.aborted && currentHead.current === requestedHead) setError(true);
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false); }
    }
  }, [cursor, headKey, pageHead, invalidHead]);
  const ownsHead = pageHead === headKey;
  return { rows: ownsHead ? rows : [], hasMore: Boolean(ownsHead ? cursor : head) && !invalidHead,
    loading: ownsHead && loading, error: (ownsHead && error) || invalidHead, loadOlder };
}
