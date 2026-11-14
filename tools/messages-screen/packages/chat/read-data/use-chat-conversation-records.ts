//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Narrow owner hook for chat-session records. This hook owns only:
// - canonical live-conversation reads from Conversations package projections
// - addressed history reads of `chat-session-window:latest`
// - sorting them into Chat session rows
// - owner writes for rename and rescan
//
// Consumer-local search/filter/grouping state lives in the consuming views.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Shared owner seam only — no consumer-local filter state
// 2. Sessions are returned sorted by activity without transcript-body reads
// 3. Rename/rescan stay on owner actions, never direct transact calls
// 4. No browser-owned filesystem scan or session cache
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { useCallback, useMemo, useState } from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { renameChatConversation } from '@/packages/chat/do-work/rename-chat-conversation';
import { refreshChatHistory } from '@/packages/chat/do-work/refresh-chat-history';
import {
  buildSessionEntries,
  sortByActivity,
} from '@/packages/chat/show/build-chat-conversation-list';
import {
  decodeActiveChatSessionWindowPayload,
  type ChatConversationRecord,
} from '@/packages/chat/read-data/read-chat-sessions';
import { useChatConversationProjections } from '@/packages/chat/read-data/use-chat-conversation-projections';

export function isChatConversationRecordsLoading(input: {
  sessionIndexEntry: unknown;
  refreshing: boolean;
}): boolean {
  return input.refreshing;
}

export function useChatConversationRecords() {
  const sessionIndexEntry = useBitfieldData('chat-session-window');
  // Live in-app chats are canonical Conversations records. The package projection
  // reacts after each explicit publication, while slow filesystem materialization
  // remains solely for historical source transcripts.
  const canonicalConversations = useChatConversationProjections();
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const sessionRecords = useMemo<ChatConversationRecord[]>(() => {
    const liveRows = canonicalConversations.sessions;
    const liveIds = new Set(liveRows.map((row) => row.recordId));
    // The canonical projection OWNS live chats; drop the materialized window's lagging,
    // per-source-capped live-chat rows (joined on recordId) so a conversation never
    // double-lists and the newest live chats are never hidden by the cap.
    const historyRows = decodeActiveChatSessionWindowPayload(sessionIndexEntry).rows.filter(
      (row) => !row.recordId.startsWith('thread:live-chat:')
        && !row.recordId.startsWith('addressed-exchange:')
        && !liveIds.has(row.recordId),
    );
    return [...liveRows, ...historyRows];
  }, [sessionIndexEntry, canonicalConversations.sessions]);
  const sessions = useMemo(
    () =>
      sortByActivity(
        buildSessionEntries(sessionRecords),
      ),
    [sessionRecords],
  );

  const renameSession = useCallback(async (recordId: string, title: string) => {
    try {
      setActionError(null);
      await renameChatConversation({
        sessionId: recordId,
        title,
      });
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to rename session',
      );
    }
  }, []);

  const rescan = useCallback(async () => {
    setRefreshing(true);
    setActionError(null);
    try {
      await refreshChatHistory();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to refresh session feeds',
      );
    } finally {
      setRefreshing(false);
    }
  }, []);

  return {
    sessions,
    loading: canonicalConversations.loading ||
      isChatConversationRecordsLoading({ sessionIndexEntry, refreshing }),
    error: actionError ?? canonicalConversations.error,
    renameSession,
    rescan,
  };
}
