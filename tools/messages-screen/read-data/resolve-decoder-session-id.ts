// PORTED FROM: bitfield-packages/packages/chat/read-data/resolve-decoder-session-id.ts @ e99ac5976
// packages/chat/read-data/resolve-decoder-session-id.ts
//
// Purpose: resolve the DECODER session-id for the active conversation tab.
//
// Non-negotiable invariant (L098 translation boundary): the UI tab-key and the
// source decoder's session-id are DISTINCT id spaces. For source-backed threads
// the tab-key is the transcript-mapper's `thread_ref`
// (`thread:<source_ref>:<raw-session-id>`), while every decoder-bound read
// (decode_window's `WHERE guid = ?`, materialize-transcript's overlay target)
// matches on the RAW source session-id carried on the session record's
// `sessionId` field. Passing the tab-key to the decoder makes source
// transcripts render empty (the prefixed thread_ref never matches the raw id).
//
// This resolver is the single, named structural property (L063) that keeps the
// two id spaces from being conflated: given the active tab-key (a session
// record's `recordId`) it returns that record's canonical decoder `sessionId`.
// It holds for ANY source whose thread_ref differs from its raw id — not just
// iMessage — because it reads the id the mapper stamped, never re-deriving it.

/** Minimal session-record shape this resolver depends on. */
export interface DecoderSessionRecord {
  /** UI tab-key — the mapper thread_ref for source-backed threads. */
  recordId: string;
  /** Canonical decoder session-id — the raw source session-id. */
  sessionId: string;
}

/**
 * Resolve the canonical decoder session-id for the active tab.
 *
 * @param activeSessionId the active UI tab-key (a session record `recordId`),
 *   or null when no thread is open.
 * @param sessions the current session records.
 * @returns the matched record's `sessionId` (raw decoder id); falls back to
 *   `activeSessionId` itself when no record matches (in-app AI sessions key
 *   recordId === sessionId, so this is a safe identity), or null when no tab is
 *   open.
 */
export function resolveDecoderSessionId(
  activeSessionId: string | null,
  sessions: readonly DecoderSessionRecord[],
): string | null {
  if (!activeSessionId) return activeSessionId;
  const match = sessions.find((session) => session.recordId === activeSessionId);
  return match?.sessionId ?? activeSessionId;
}
