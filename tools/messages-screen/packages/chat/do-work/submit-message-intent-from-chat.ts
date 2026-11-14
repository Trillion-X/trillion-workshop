import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
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
const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';
const ENGINE_READ_CURRENT_OPERATION = 'engine.operation.read-current';
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

interface ViewerIntentFeed {
  records: ViewerIntentRecord[];
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

function decodeFeed(value: unknown): ViewerIntentFeed {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { records: [] };
  const records = (value as Record<string, unknown>).records;
  return {
    records: Array.isArray(records)
      ? records.filter((r): r is ViewerIntentRecord => !!r && typeof r === 'object')
      : [],
  };
}

async function readViewerIntentFeed(): Promise<ViewerIntentFeed> {
  const result = await sendLabelOperation({
    operation_label: ENGINE_READ_CURRENT_OPERATION,
    address_label: VIEWER_INTENT_FEED_ADDRESS,
  });
  return decodeFeed(result.found === true ? result.payload ?? null : null);
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
 * Append one viewer-intent event to the chat-owned ledger (read-modify-write, so
 * the append-only event log preserves add-then-remove history the mapper folds at
 * render time). This is the DURABLE half — it always runs, capability or not.
 */
export async function recordViewerIntent(
  record: ViewerIntentRecord,
): Promise<void> {
  const feed = await readViewerIntentFeed();
  const records = [...feed.records, record];
  await sendLabelOperation({
    operation_label: ENGINE_WRITE_BATCH_OPERATION,
    writes: [
      {
        address_label: VIEWER_INTENT_FEED_ADDRESS,
        path_labels: [],
        payload: { records },
      },
    ],
  });
}

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
    await forwardReactEgress(input.reactCapability, record);
  }
  return record;
}
