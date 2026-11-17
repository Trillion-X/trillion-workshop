// packages/chat/do-work/build-ledger-observations-bundle.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Maintain the `package::chat::conversation-ledger::observations` projection: a
// single record holding every live conversation in the EXACT batch shape the
// decode-addressed-exchange leaf consumes —
//   { "accepted": [ { source_ref, conversation, turns }, ... ] }
// so the OCI materialize workflow can fold live chats into chat-session-window
// (#56) WITHOUT a sandboxed process trying to read engine records, and WITHOUT a
// second source of truth (the per-conversation/turn records stay canonical; this
// is a derived read-projection, exactly like the existing ledger index).
//
// Pure transform (no I/O): the writer reads the current bundle, calls this to
// upsert one conversation's entry (accumulating its turns by turnId), and writes
// the result in the same write-batch as the index/conversation/turn records.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure — no engine, no network. Unit-testable with plain data.
// 2. Idempotent per turn: re-recording the same turnId never duplicates it.
// 3. The entry shape is EXACTLY decode-addressed-exchange's observation shape.
// 4. No model/provider vocabulary — turns pass through opaquely.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type {
  AddressedExchangeConversation,
  AddressedExchangeTurn,
} from '../read-data/read-addressed-exchange-ledger';

/** The default source_ref for live in-app conversations (the live-chat OCI source). */
export const LIVE_CHAT_SOURCE_REF = 'live-chat';

/** One observation entry = one conversation + its turns (decoder input shape). */
export interface LedgerObservationEntry {
  source_ref: string;
  conversation: AddressedExchangeConversation;
  turns: AddressedExchangeTurn[];
}

/** The bundle record payload: a batch of observations the decoder reads. */
export interface LedgerObservationsBundle {
  accepted: LedgerObservationEntry[];
}

/** Coerce an unknown current-payload into a well-formed bundle (tolerant decode). */
export function decodeLedgerObservationsBundle(value: unknown): LedgerObservationsBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { accepted: [] };
  const accepted = (value as Record<string, unknown>).accepted;
  if (!Array.isArray(accepted)) return { accepted: [] };
  const entries: LedgerObservationEntry[] = [];
  for (const raw of accepted) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const conversation = e.conversation as AddressedExchangeConversation | undefined;
    if (!conversation || typeof conversation.conversationId !== 'string') continue;
    entries.push({
      source_ref: typeof e.source_ref === 'string' ? e.source_ref : LIVE_CHAT_SOURCE_REF,
      conversation,
      turns: Array.isArray(e.turns) ? (e.turns as AddressedExchangeTurn[]) : [],
    });
  }
  return { accepted: entries };
}

/** Merge new turns into an entry's turn list — dedupe by turnId, order by sequence. */
function mergeTurns(
  existing: readonly AddressedExchangeTurn[],
  incoming: readonly AddressedExchangeTurn[],
): AddressedExchangeTurn[] {
  const byId = new Map<string, AddressedExchangeTurn>();
  for (const turn of existing) byId.set(turn.turnId, turn);
  for (const turn of incoming) byId.set(turn.turnId, turn); // incoming wins (latest)
  return [...byId.values()].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
}

/**
 * Upsert one conversation's observation entry into the bundle, accumulating its
 * turns. Returns a NEW bundle (pure). The updated entry moves to the FRONT so the
 * bundle is newest-first (most-recently-active conversation first). This is the
 * live-chat source's half of the materialize contract: every observer returns
 * observations newest-first, because the materializer keeps only the first
 * `per_source_limit` per source BEFORE decoding (a perf necessity for file
 * sources). If this bundle were oldest-first, the cap would drop the user's
 * newest conversations and surface only their oldest ones (#60). The inline
 * observer is blind to observation shape (it cannot sort), so order is owned
 * here, where the activity is known.
 */
export function buildLedgerObservationsBundle(
  existing: LedgerObservationsBundle,
  conversation: AddressedExchangeConversation,
  newTurns: readonly AddressedExchangeTurn[],
  sourceRef: string = LIVE_CHAT_SOURCE_REF,
): LedgerObservationsBundle {
  const others = existing.accepted.filter(
    (entry) => entry.conversation.conversationId !== conversation.conversationId,
  );
  const prior = existing.accepted.find(
    (entry) => entry.conversation.conversationId === conversation.conversationId,
  );
  const entry: LedgerObservationEntry = {
    source_ref: sourceRef,
    conversation,
    turns: mergeTurns(prior?.turns ?? [], newTurns),
  };
  return { accepted: [entry, ...others] };
}
