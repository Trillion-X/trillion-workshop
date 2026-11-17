//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Decode the live conversation-ledger observations bundle
// (`package::chat::conversation-ledger::observations`) into the SAME
// chat-session-window row shape the sidebar renders — so the sidebar can read
// live in-app chats DIRECTLY and REACTIVELY (#61), instead of waiting for the
// slow filesystem-scanning materialize (which rescans every CLI .jsonl source on
// each run, ~tens of seconds). The observations bundle is written in the SAME
// write-batch as every chat turn (build-ledger-observations-bundle.ts), so a
// `useBitfieldData` read of it re-renders the instant a turn lands — live chats
// appear and update with ZERO materialize.
//
// This is the TS twin of do-work/process-scripts/decode-addressed-exchange.py +
// materialize-conversations.py `thread_to_row`. It is intentionally byte-for-byte
// compatible with that mapping (`recordId = thread:{source_ref}:{conversationId}`,
// `messageCount = #content turns`, title = first human line) so a live row and
// its eventual materialized twin DEDUPE on `recordId` rather than double-listing.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure — no engine, no network, no I/O. Unit-testable with plain data.
// 2. Row shape IDENTICAL to materialize's live-chat rows (recordId/sessionId/
//    title/lastActivityAt/messageCount/lastMessagePreview), so the two paths join
//    on recordId and never duplicate a conversation.
// 3. No model/provider branches — role is the only discriminant (L090). A turn's
//    speakerRef passes through opaquely for the participant indicator (#57).
// 4. Tolerant decode — any malformed entry is skipped, never throws; an empty or
//    absent bundle yields [] (a chat app with no conversations renders cleanly).
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { ChatConversationRecord } from './read-chat-sessions';
import type { AgentMessage } from './chat-message-types';
import { decodeMessagePerformControls } from './read-addressed-exchange-ledger';

/** Preview/title clamp — mirrors decode-addressed-exchange.py PREVIEW_CHARS. */
const PREVIEW_CHARS = 200;
/** Default source_ref for live in-app conversations (the live-chat OCI source). */
const LIVE_CHAT_SOURCE_REF = 'live-chat';

interface RawTurn {
  sequence?: number;
  role?: string;
  content?: string;
  createdAt?: string;
  participantRef?: string | null;
  speakerRef?: string | null;
  modelRef?: string | null;
  controls?: unknown;
}
interface RawConversation {
  conversationId?: string;
  title?: string | null;
  createdAt?: string;
  updatedAt?: string;
}
interface RawEntry {
  source_ref?: string;
  conversation?: RawConversation;
  turns?: RawTurn[];
}

/**
 * Peel the observation list from any container the bundle/read-reply can take —
 * the exact same shapes observe-inline.py tolerates ({accepted}, {payload:{...}},
 * a bare list). Keeps this decoder usable directly against a `useBitfieldData`
 * value without the caller knowing the envelope shape.
 */
function peelAccepted(raw: unknown): RawEntry[] {
  const PEEL_KEYS = ['accepted', 'observations', 'payload', 'records', 'rows', 'items'] as const;
  if (Array.isArray(raw)) return raw as RawEntry[];
  if (raw && typeof raw === 'object') {
    for (const key of PEEL_KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as RawEntry[];
      if (value && typeof value === 'object') {
        const nested = peelAccepted(value);
        if (nested.length) return nested;
      }
    }
  }
  return [];
}

function speakerOf(turn: RawTurn): string | null {
  const ref = turn.speakerRef || turn.participantRef || turn.modelRef;
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

/**
 * Decode the live observations bundle into chat-session-window rows (newest-first
 * preserved from the bundle order — see build-ledger-observations-bundle.ts).
 */
export function decodeLedgerObservationsRows(bundle: unknown): ChatConversationRecord[] {
  const rows: ChatConversationRecord[] = [];
  for (const entry of peelAccepted(bundle)) {
    const conversation = entry?.conversation;
    const conversationId = conversation?.conversationId;
    if (!conversation || typeof conversationId !== 'string' || conversationId.length === 0) continue;

    const sourceRef = typeof entry.source_ref === 'string' && entry.source_ref ? entry.source_ref : LIVE_CHAT_SOURCE_REF;
    const turns = [...(Array.isArray(entry.turns) ? entry.turns : [])]
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
    const contentTurns = turns.filter((turn) => typeof turn.content === 'string' && turn.content.length > 0);

    // Title = first human line that is not an injected control block (mirrors the
    // CLI decoder: a `<...>` lead is a system/tool wrapper, never a human title).
    let title: string | null = null;
    for (const turn of turns) {
      const text = (turn.content ?? '').trim();
      if ((turn.role ?? '').toLowerCase() === 'user' && text && !text.startsWith('<')) {
        title = text.slice(0, PREVIEW_CHARS);
        break;
      }
    }
    title = title ?? conversation.title ?? conversationId;

    const lastText = contentTurns.length ? (contentTurns[contentTurns.length - 1].content ?? '').slice(0, PREVIEW_CHARS) : null;
    const timestamps = turns.map((turn) => turn.createdAt).filter((value): value is string => typeof value === 'string' && value.length > 0);
    const startedAt = timestamps[0] ?? conversation.createdAt ?? conversation.updatedAt ?? '';
    const lastActivityAt = (timestamps.length ? timestamps[timestamps.length - 1] : null) ?? conversation.updatedAt ?? conversation.createdAt ?? startedAt;

    // Participants: the assistant speakers in the thread (who answered), newest
    // last — keeps the #57 participant indicator working for live rows.
    const participantRefs = [
      ...new Set(
        turns
          .filter((turn) => (turn.role ?? '').toLowerCase() !== 'user')
          .map(speakerOf)
          .filter((ref): ref is string => ref !== null),
      ),
    ];

    rows.push({
      recordId: `thread:${sourceRef}:${conversationId}`,
      sessionId: conversationId,
      participantRefs,
      participantRef: participantRefs[participantRefs.length - 1] ?? '',
      wayRefs: [],
      serviceConnectionRefs: [],
      legacySourceAdapterRef: sourceRef,
      title,
      prompt: lastText,
      projectSlug: '',
      projectName: null,
      startedAt,
      lastActivityAt,
      messageCount: contentTurns.length,
      sourcePresent: true,
      lastMessagePreview: lastText,
    });
  }
  return rows;
}

/**
 * Render the message STREAM for one in-app (ledger-backed) conversation directly
 * from the SAME observations bundle the sidebar list reads (#61).
 *
 * WHY: a conversation created in-app via the producer persists its turns to the
 * conversation-ledger, NOT to a transcript FILE. The stream's primary loader
 * (`readChatTranscriptPage`) requires a `filePath` and the per-session window
 * `selected-chat-message-window:<id>:latest` is only written by the filesystem
 * materialize — neither exists for a live in-app chat. Result: the sidebar showed
 * the conversation (it reads this bundle) while the message pane said "No messages
 * yet". This is the stream twin of `decodeLedgerObservationsRows`: same source,
 * matched by `conversationId === sessionId`, so list and stream are always
 * consistent. Pure, tolerant, no I/O. Returns [] for an unknown/absent session.
 */
export function ledgerObservationsToAgentMessages(
  bundle: unknown,
  sessionId: string | null | undefined,
): AgentMessage[] {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return [];
  for (const entry of peelAccepted(bundle)) {
    const conversationId = entry?.conversation?.conversationId;
    if (typeof conversationId !== 'string' || conversationId.length === 0) continue;
    // The caller may pass either the bare conversationId OR the sidebar row's
    // recordId ("thread:<source_ref>:<conversationId>"). Match both: exact, or the
    // conversationId as the final ":"-delimited suffix of the recordId.
    const matches = conversationId === sessionId || sessionId.endsWith(`:${conversationId}`);
    if (!matches) continue;
    const turns = [...(Array.isArray(entry.turns) ? entry.turns : [])]
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
    const messages: AgentMessage[] = [];
    for (const turn of turns) {
      const content = typeof turn.content === 'string' ? turn.content : '';
      if (!content) continue;
      // role is the only discriminant (L090) — no model/provider branch. The ledger
      // writes the human side as either "human" or "user"; everything else is the
      // agent side. A turn's speaker passes through opaquely (participant indicator #57).
      const rawRole = (turn.role ?? '').toLowerCase();
      const role: 'human' | 'assistant' = rawRole === 'user' || rawRole === 'human' ? 'human' : 'assistant';
      messages.push({
        id: `ledger:${sessionId}:${turn.sequence ?? messages.length}`,
        type: 'text',
        content,
        timestamp: typeof turn.createdAt === 'string' ? turn.createdAt : '',
        role,
        ...(() => {
          const performControls = decodeMessagePerformControls(turn.controls);
          return performControls.length > 0 ? { performControls } : {};
        })(),
      });
    }
    return messages;
  }
  return [];
}
