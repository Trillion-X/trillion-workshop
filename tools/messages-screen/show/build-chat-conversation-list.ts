// PORTED FROM: bitfield-packages/packages/chat/show/build-chat-conversation-list.ts @ e99ac5976
// packages/conversations/show/build-conversation-list.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure conversations helpers shared by conversations surfaces. This file
// owns:
// - preserving canonical chat-session rows without transcript-body reads
// - sorting and filtering session lists
// - date grouping
// - lightweight display formatting
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure helpers only — zero React/runtime authority
// 2. Session rows come from the chat-session metadata feed
// 3. Filtering and grouping operate on caller-provided session arrays
// 4. Selected transcript pages, not the sidebar list, own transcript content
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { ChatConversationRecord } from '../read-data/read-chat-sessions';

export interface ChatSessionFilter {
  search: string;
  participantRef: string | null;
  projectName: string | null;
}

export interface ChatSessionDateGroup {
  label: string;
  sessions: ChatConversationRecord[];
}

export const DEFAULT_SESSION_FILTER: ChatSessionFilter = {
  search: '',
  participantRef: null,
  projectName: null,
};

/** Sort sessions by lastActivityAt descending (newest first). */
export function sortByActivity(sessions: ChatConversationRecord[]): ChatConversationRecord[] {
  return [...sessions].sort(
    (a, b) =>
      new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
}

/** Filter sessions by search text, participant ref, and project name. */
export function filterSessions(
  sessions: ChatConversationRecord[],
  filter: ChatSessionFilter,
): ChatConversationRecord[] {
  let result = sessions;

  if (filter.search.trim()) {
    const lower = filter.search.toLowerCase();
    result = result.filter(
      (session) =>
        (session.title && session.title.toLowerCase().includes(lower)) ||
        session.sessionId.toLowerCase().includes(lower) ||
        session.projectSlug.toLowerCase().includes(lower) ||
        session.recordId.toLowerCase().includes(lower),
    );
  }

  if (filter.participantRef) {
    result = result.filter((session) => session.participantRef === filter.participantRef);
  }

  if (filter.projectName) {
    result = result.filter((session) => session.projectName === filter.projectName);
  }

  return result;
}

/** Extract unique participant refs from a session list, sorted alphabetically. */
export function extractUniqueParticipants(sessions: ChatConversationRecord[]): string[] {
  const ids = new Set<string>();
  for (const session of sessions) ids.add(session.participantRef);
  return Array.from(ids).sort();
}

/** Extract unique project names (non-null) from a session list, sorted. */
export function extractUniqueProjects(sessions: ChatConversationRecord[]): string[] {
  const names = new Set<string>();
  for (const session of sessions) {
    if (session.projectName) names.add(session.projectName);
  }
  return Array.from(names).sort();
}

/**
 * Group sessions into date buckets: Today, Yesterday, This Week, Older.
 * Expects sessions to be pre-sorted by lastActivityAt descending.
 */
export function groupByDate(sessions: ChatConversationRecord[]): ChatSessionDateGroup[] {
  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = todayStart - 6 * 86_400_000;

  const today: ChatConversationRecord[] = [];
  const yesterday: ChatConversationRecord[] = [];
  const thisWeek: ChatConversationRecord[] = [];
  const older: ChatConversationRecord[] = [];

  for (const session of sessions) {
    const timestamp = new Date(session.lastActivityAt).getTime();
    if (timestamp >= todayStart) {
      today.push(session);
    } else if (timestamp >= yesterdayStart) {
      yesterday.push(session);
    } else if (timestamp >= weekStart) {
      thisWeek.push(session);
    } else {
      older.push(session);
    }
  }

  const groups: ChatSessionDateGroup[] = [];
  if (today.length > 0) groups.push({ label: 'Today', sessions: today });
  if (yesterday.length > 0) groups.push({ label: 'Yesterday', sessions: yesterday });
  if (thisWeek.length > 0) groups.push({ label: 'This Week', sessions: thisWeek });
  if (older.length > 0) groups.push({ label: 'Older', sessions: older });
  return groups;
}

/** Format file size in human-readable form. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** Format a date string to relative time ("2h ago") or short absolute ("Feb 11"). */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function buildSessionEntries(
  sessions: ChatConversationRecord[],
): ChatConversationRecord[] {
  return sessions;
}
