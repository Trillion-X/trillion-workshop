// PORTED FROM: bitfield-packages/packages/chat/do-work/submit-message-intent-from-chat.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';
import type { ConversationSendCapability } from '../read-data/read-chat-sessions';

/**
 * Chat-side dispatch for a viewer MESSAGE INTENT authored ON a message — the
 * generative primitive behind reactions (and, as pure DATA configs, pin / star /
 * bookmark / flag): viewer intent -> addressed durable subject annotation ->
 * self-describing state-event -> optimistic render at provenance 0 -> converge to
 * AUTHORITATIVE only if a real egress path exists.
 *
 * =============================================================================
 * FAIL-CLOSED REALITY GATE (why a reaction is a LOCAL durable annotation)
 * =============================================================================
 * The iMessage transport sends TEXT ONLY — macOS supported automation exposes no
 * tapback/reaction egress. So a reaction the user authors CANNOT be delivered to
 * the recipient today. The honest 1000x design: the authored reaction is the
 * user's OWN durable annotation on the message subject atom (`targetAtomRef`),
 * written to a chat-owned append-only ledger and rendered at PROVISIONAL
 * provenance (faint, "yours") by the SAME materializer + renderer that already
 * fold source-of-record tapbacks. It NEVER claims it reached the other person.
 *
 * Real egress turns on the day a source declares a `reactCapability` (DATA,
 * mirroring `sendCapability` = {frontDoorAction, channel, destinationId}): this
 * blind courier then ALSO forwards the intent to that front door — ZERO code
 * change here (L069/L090). Absent the capability, the durable annotation is the
 * whole effect, and that is correct, not a stub.
 *
 * =============================================================================
 * BLIND COURIER (no god package, no Society vocabulary in transport)
 * =============================================================================
 * This module knows ONE thing: how to append a self-describing intent record to
 * chat's OWN ledger, and how to forward an opaque capability to an opaque front
 * door. It never names a channel, never enumerates a symbol set, never parses a
 * phone number, never picks a transport. `symbol` (the tapback glyph or the
 * pin/star key) and `intentKind` ride opaquely; adding a new reaction glyph or a
 * whole new annotation kind is DATA in the palette + a decoder, never an edit
 * here. Routing / consent / exactly-once all live behind the front door (SSOT).
 *
 * The extensive documentation in this codebase is a critical design feature.
 * You are forbidden from simplifying or removing it.
 * =============================================================================
 */

const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_APPEND_RECORD_OPERATION = 'engine.operation.append-record';
// The chat-owned append-only ledger of viewer annotations. `read-chat-session-
// transcript-page` (#156) reads this address, mounts it as `viewer-reactions-
// feed.json`, and its `decode-viewer-reactions` overlay folds the events onto the
// open thread's native page — the durable render path (zero materializer change).
const VIEWER_INTENT_FEED_ADDRESS = 'package::chat::viewer-reaction-ledger::feed';

const textDecoder = new TextDecoder();

interface TargetReplyEnvelope {
  payload?: Uint8Array;
}

/**
 * A single self-describing viewer-intent event. This is exactly the record shape
 * `decode_viewer_reactions.py` reads: `{intent_id, target_atom_ref,
 * target_thread_ref, symbol, reaction_kind?, actor?, at?}` plus an `intent_kind`
 * discriminant so one ledger can carry reactions AND future pin/star/bookmark
 * events (each folded by its own decoder — the reaction decoder rejects records
 * with no `symbol`, fail-closed).
 */
export interface ViewerIntentRecord {
  intent_id: string;
  intent_kind: string;
  target_atom_ref: string;
  target_thread_ref: string;
  symbol: string;
  reaction_kind: 'added' | 'removed';
  actor: string;
  at: string;
}

export interface SubmitMessageIntentFromChatInput {
  /** The tapped message's opaque content-addressed atomRef (the subject). */
  targetAtomRef: string;
  /** The open thread's opaque native thread_ref (`thread:{source}:{session}`). */
  targetThreadRef: string;
  /** Reaction glyph or annotation key — opaque; never enumerated here. */
  symbol: string;
  /** Discriminant: 'reaction' (default) | 'pin' | 'star' | ... — DATA-driven. */
  intentKind?: string;
  /** 'added' places the annotation; 'removed' un-does it (fold cancels). */
  reactionKind?: 'added' | 'removed';
  /** The authoring viewer ("me" by default — the local owner). */
  actor?: string;
  now?: Date;
  intentId?: string;
  /**
   * Present ONLY when the source declares reactions can egress. Absent for
   * iMessage (text-only) — the durable annotation is then the whole effect.
   */
  reactCapability?: ConversationSendCapability | null;
}

function randomIntentId(): string {
  const cryptoSource = globalThis.crypto;
  const value = cryptoSource && typeof cryptoSource.randomUUID === 'function'
    ? cryptoSource.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `intent:${value}`;
}

async function sendLabelOperation(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reply = await sendRequestToBitfieldTarget({
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload,
  }) as TargetReplyEnvelope;
  const bytes = reply.payload;
  if (!(bytes instanceof Uint8Array)) return {};
  const parsed = JSON.parse(textDecoder.decode(bytes)) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

export function buildViewerIntentRecord(
  input: SubmitMessageIntentFromChatInput,
): ViewerIntentRecord {
  const now = input.now ?? new Date();
  return {
    intent_id: input.intentId ?? randomIntentId(),
    intent_kind: input.intentKind ?? 'reaction',
    target_atom_ref: input.targetAtomRef,
    target_thread_ref: input.targetThreadRef,
    symbol: input.symbol,
    reaction_kind: input.reactionKind ?? 'added',
    actor: input.actor ?? 'me',
    at: now.toISOString(),
  };
}

/**
 * Append one viewer-intent event to the chat-owned ledger (store-owned compare and retry, so
 * the append-only event log preserves add-then-remove history the mapper folds at
 * render time). This is the DURABLE half — it always runs, capability or not.
 */
export async function recordViewerIntent(
  record: ViewerIntentRecord,
): Promise<void> {
  let result: Record<string, unknown>;
  try { result = await sendLabelOperation({
    operation_label: ENGINE_APPEND_RECORD_OPERATION,
    address_label: VIEWER_INTENT_FEED_ADDRESS,
    field: 'records',
    identity_field: 'intent_id',
    item: record,
  }); } catch (cause) {
    if (!(cause && typeof cause === 'object' && (cause as { append_outcome?: unknown }).append_outcome === 'unknown')) throw cause;
    throw Object.assign(new Error('We could not confirm whether your annotation was saved. Retry this same action to check.'),
      { annotation_outcome: 'unknown', intent_id: record.intent_id, cause });
  }
  if (result.durable !== true || (result.appended !== 0 && result.appended !== 1)) {
    throw Object.assign(new Error('We could not confirm whether your annotation was saved. Retry this same action to check.'),
      { annotation_outcome: 'unknown', intent_id: record.intent_id });
  }
}

// Reuse the actual result, including an uncertain failure, for the same immutable event.
// A repeated click while the first dispatch is running must not manufacture either a second
// send or a false failure after the first dispatch succeeds.
const egressAttempts = new Map<string, Promise<unknown>>();

/**
 * Forward the intent to a source-declared react front door. Only called when a
 * `reactCapability` exists — the fail-closed egress gate. Blind forward: chat
 * never interprets the capability.
 */
async function forwardReactEgress(
  capability: ConversationSendCapability,
  record: ViewerIntentRecord,
): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: capability.frontDoorAction,
      include_steps: false,
      include_output: false,
      input: {
        intent_id: record.intent_id,
        destination_id: capability.destinationId,
        channel: capability.channel,
        target_atom_ref: record.target_atom_ref,
        reply_to_thread_ref: record.target_thread_ref,
        symbol: record.symbol,
        reaction_kind: record.reaction_kind,
        requested_at: record.at,
      },
    },
  });
}

/**
 * The single entry point the composer calls. Always writes the durable annotation;
 * additionally forwards real egress IFF the source declared it can. Returns the
 * record so the caller can reconcile its optimistic echo.
 */
export async function submitMessageIntentFromChat(
  input: SubmitMessageIntentFromChatInput,
): Promise<ViewerIntentRecord> {
  const record = buildViewerIntentRecord(input);
  await recordViewerIntent(record);
  if (input.reactCapability && input.reactCapability.frontDoorAction) {
    // A retry with the same immutable ID may confirm a previously uncertain append, but must not
    // blindly repeat an egress whose acknowledgement was lost.
    let sending = egressAttempts.get(record.intent_id);
    if (!sending) {
      sending = forwardReactEgress(input.reactCapability, record);
      egressAttempts.set(record.intent_id, sending);
    }
    try { await sending; }
    catch (cause) { throw Object.assign(new Error('Your annotation was saved. Sending could not be confirmed.'), { annotation_saved: true, intent_id: record.intent_id, cause }); }
  }
  return record;
}

/** A transport refusal after the durable annotation was saved must never be called a save failure. */
export function viewerIntentFailure(error: unknown): { saved: boolean; uncertain?: boolean; message: string } {
  const saved = Boolean(error && typeof error === 'object' && (error as { annotation_saved?: unknown }).annotation_saved === true);
  const uncertain = Boolean(error && typeof error === 'object' && (error as { annotation_outcome?: unknown }).annotation_outcome === 'unknown');
  return { saved, ...(uncertain ? { uncertain: true } : {}), message: saved ? 'Your annotation was saved. Sending could not be confirmed.'
    : uncertain ? 'We could not confirm whether your annotation was saved. Retry this same action to check.'
      : 'Your annotation could not be saved. Try again.' };
}
