//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The viewer half of the "cursored activity frontier" primitive (L069). Every
// feed (iMessage thread, AI-model chat, transcript) carries a monotonic
// ACTIVITY FRONTIER — its `messageCount` — that only ever advances as messages
// arrive. Each viewer carries a SEEN FRONTIER per feed: the frontier value they
// have already looked at. A feed is UNREAD exactly when
//
//     activityFrontier > seenFrontier
//
// This one integer comparison drives the iMessage-style unread dot uniformly
// across EVERY feed type — the handler never enumerates the source (enum
// dissolution). Live-update (the feed re-rendering when new messages arrive) is
// owned separately by the clock::tick → re-materialize chain; this hook only
// decides whether the newly-arrived frontier is unseen.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Frontier is ARRIVAL-monotonic (messageCount), NEVER display time — a
//    backfilled old message must not raise the dot.
// 2. Baseline-on-first-observe: a feed already present when the viewer opened
//    the app is seeded as seen up to its current frontier, so historical
//    conversations are NEVER dotted — only messages that ARRIVE afterward do.
// 3. The seen cursor is monotonic — it only advances, never rewinds.
// 4. The currently-open feed is never unread; while it is open, its seen cursor
//    tracks its activity frontier so incoming messages clear as they render.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { useEffect, useMemo, useRef } from 'react';
import type { ChatConversationRecord } from '@/packages/chat/read-data/read-chat-sessions';

export interface UnreadFrontier {
  /** True when the feed has an activity frontier beyond the viewer's seen cursor. */
  isUnread: (recordId: string) => boolean;
  /** Count of feeds currently unread (drives aggregate badges). */
  unreadCount: number;
}

/**
 * Compute the unread set for a list of feeds against a per-feed seen cursor.
 *
 * The seen cursor lives in a stable ref (identity never changes across renders)
 * so recomputation is driven purely by the reactive `sessions` list advancing —
 * when clock::tick → re-materialize bumps a feed's messageCount, `sessions`
 * changes identity, this hook recomputes, and the feed lights up.
 */
export function useUnreadFrontier(
  sessions: ChatConversationRecord[],
  activeSessionId: string | null,
): UnreadFrontier {
  const seenRef = useRef<Map<string, number>>(new Map());
  const seen = seenRef.current;

  // Baseline-on-first-observe (invariant 2): the first time a feed is seen, seed
  // its seen cursor to its current frontier so pre-existing history is not
  // dotted. Ref mutation during render is safe here — it is idempotent memo
  // seeding, not observable state.
  for (const session of sessions) {
    if (!seen.has(session.recordId)) {
      seen.set(session.recordId, session.messageCount);
    }
  }

  // The open feed tracks its own frontier (invariant 4): while a feed is open,
  // any message that arrives is considered seen the moment it renders, so the
  // dot never appears on the thread the viewer is actively reading.
  useEffect(() => {
    if (!activeSessionId) return;
    const active = sessions.find((session) => session.recordId === activeSessionId);
    if (!active) return;
    const previous = seen.get(activeSessionId) ?? 0;
    if (active.messageCount > previous) seen.set(activeSessionId, active.messageCount);
  }, [activeSessionId, sessions, seen]);

  const unreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of sessions) {
      // The open feed is never unread — the viewer is looking at it.
      if (session.recordId === activeSessionId) continue;
      const seenFrontier = seen.get(session.recordId) ?? session.messageCount;
      if (session.messageCount > seenFrontier) ids.add(session.recordId);
    }
    return ids;
  }, [sessions, activeSessionId, seen]);

  return useMemo(
    () => ({
      isUnread: (recordId: string) => unreadIds.has(recordId),
      unreadCount: unreadIds.size,
    }),
    [unreadIds],
  );
}
