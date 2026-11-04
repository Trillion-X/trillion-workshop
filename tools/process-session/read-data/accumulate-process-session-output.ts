// packages/process-session/read-data/accumulate-process-session-output.ts
//
// GENERIC accumulation of a process-session's live output feed into a growing
// text snapshot. This is process-session's OWN domain — it owns the event-feed
// wire format (V1 full feed / V2 head / V3 per-event delta), so the append-vs-
// replace fold lives HERE, next to the feed reader. Every consumer (composition-
// authoring, chat, group, …) is a BLIND caller that folds bytes → text and never
// learns the wire format (no-god-package / L098 translation boundary).
//
// Also exposes `readProcessSessionStreamHandle` — the reader that turns an opaque
// producer result payload (`{status:"streaming", session_id, event_stream_address}`)
// into a `{ sessionId, liveFeedAddress }` handle. A caller polling some action's
// result address hands the whole opaque payload here and gets back a handle it can
// pass to `useProcessSessionLiveOutput`, without reading process-session's fields.

import {
  readProcessSessionEventsFeed,
  isProcessSessionEventDeltaPayload,
  type ProcessSessionState,
} from './read-process-session-events';
import type { StreamTextSpec } from './stream-output-text';

/** A growing snapshot of a session's output, folded across many feed payloads. */
export interface ProcessSessionOutputSnapshot {
  readonly outputText: string;
  readonly lastEventNumber: number;
  readonly state: ProcessSessionState;
  readonly exitCode: number | null;
  readonly failureReason: string | null;
  /** Count of feed events that matched `sessionId` in the payload just decoded —
   *  0 means the payload said nothing new about this session. */
  readonly matchedEventCount: number;
}

export function createEmptyProcessSessionOutputSnapshot(): ProcessSessionOutputSnapshot {
  return { outputText: '', lastEventNumber: 0, state: 'running', exitCode: null, failureReason: null, matchedEventCount: 0 };
}

const OUTPUT_DECODER = new TextDecoder();

/** Decode ONE payload in isolation for `sessionId` — concatenates every output
 *  chunk (in event order) and folds the last state change seen, starting from
 *  `fallback` for whichever field the payload doesn't touch. Does not know about
 *  prior payloads — `foldProcessSessionOutput` owns append-vs-replace. */
function decodePayload(
  bytes: Uint8Array,
  sessionId: string,
  fallback: Pick<ProcessSessionOutputSnapshot, 'state' | 'exitCode' | 'failureReason'>,
): ProcessSessionOutputSnapshot {
  const feed = readProcessSessionEventsFeed(bytes);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let lastEventNumber = 0;
  let state = fallback.state;
  let exitCode = fallback.exitCode;
  let failureReason = fallback.failureReason;
  let matchedEventCount = 0;

  feed.forEachEvent({
    onOutputBytes(eventSessionId, eventNumber, _recordedAtMs, _stream, outputBytes) {
      if (eventSessionId !== sessionId) return;
      matchedEventCount += 1;
      chunks.push(outputBytes);
      totalBytes += outputBytes.byteLength;
      lastEventNumber = Math.max(lastEventNumber, eventNumber);
    },
    onSessionStateChanged(eventSessionId, eventNumber, _recordedAtMs, nextState, nextExitCode, nextFailureReason) {
      if (eventSessionId !== sessionId) return;
      matchedEventCount += 1;
      state = nextState;
      exitCode = nextExitCode;
      failureReason = nextFailureReason;
      lastEventNumber = Math.max(lastEventNumber, eventNumber);
    },
    onCommandRejected(eventSessionId, eventNumber, _recordedAtMs, reason) {
      if (eventSessionId !== sessionId) return;
      matchedEventCount += 1;
      state = 'failed';
      failureReason = reason;
      lastEventNumber = Math.max(lastEventNumber, eventNumber);
    },
  });

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }

  return { outputText: OUTPUT_DECODER.decode(combined), lastEventNumber, state, exitCode, failureReason, matchedEventCount };
}

/** Fold a newly-read process-session events payload into an existing snapshot:
 *   - V3 delta APPENDS its output text (ignored if its event number is stale).
 *   - V1 full-feed / V2 head REPLACES output text, EXCEPT a state-only V2 head
 *     (no output bytes) never blanks text already accumulated from prior deltas.
 *   - A payload matching nothing for `sessionId` is a no-op (returns `existing`). */
export function foldProcessSessionOutput(
  existing: ProcessSessionOutputSnapshot,
  bytes: Uint8Array,
  sessionId: string,
): ProcessSessionOutputSnapshot {
  const decoded = decodePayload(bytes, sessionId, { state: existing.state, exitCode: existing.exitCode, failureReason: existing.failureReason });
  if (decoded.matchedEventCount === 0) return existing;

  let result: ProcessSessionOutputSnapshot;
  if (isProcessSessionEventDeltaPayload(bytes)) {
    if (decoded.lastEventNumber <= existing.lastEventNumber && existing.lastEventNumber > 0) return existing;
    result = { ...decoded, outputText: existing.outputText + decoded.outputText };
  } else {
    // Full-feed / head: state-only (no output bytes) keeps accumulated text.
    const outputText = decoded.outputText.length > 0 ? decoded.outputText : existing.outputText;
    result = { ...decoded, outputText };
  }

  // Idempotence guard (mirrors chat's ChatView applyProcessSessionEvents): when the
  // store re-delivers an UNCHANGED payload with a fresh Uint8Array identity — which a
  // current-value address subscription does on every re-render — a fold that always
  // returns a NEW object makes React's setState schedule another render, then another
  // (Maximum update depth exceeded / React #185). Returning the SAME reference when
  // nothing material changed lets setState bail so no re-render is scheduled. Genuine
  // advances (a new delta, a state/exit change) differ in a compared field and flow.
  if (
    result.outputText === existing.outputText
    && result.lastEventNumber === existing.lastEventNumber
    && result.state === existing.state
    && result.exitCode === existing.exitCode
    && result.failureReason === existing.failureReason
  ) {
    return existing;
  }
  return result;
}

/** An opaque-to-the-caller handle naming a live session + the address to tail. */
export interface ProcessSessionStreamHandle {
  readonly sessionId: string;
  /** The HEAD/feed address the two-hop hook reads for terminal state + the
   *  authoritative `bytesWritten` total (prefers `event_feed_address`; falls back
   *  to `event_stream_address` if that's all a producer supplied). */
  readonly liveFeedAddress: string;
  /** The per-event delta STREAM address, when the producer supplies it at session
   *  start. Handing it here lets the lossless fold subscribe to the stream
   *  IMMEDIATELY (no HEAD-discovery round-trip → no cold-start delta loss). When
   *  absent, the hook re-discovers the stream from the HEAD (later, lossier start). */
  readonly streamAddress?: string;
  /** `textSpec` (optional) locates assistant text in raw JSONL stdout; absent ⇒
   *  raw stdout already is the text. */
  readonly textSpec?: StreamTextSpec;
  /** The AUTHORITATIVE terminal-output address, when the producer supplies it at
   *  session start. The producer writes the COMPLETE final output bytes here once the
   *  session is terminal (after output EOF AND child exit), immune to live-delta loss.
   *  The hook reads it on terminal and finalizes from it — never a truncated live fold. */
  readonly terminalOutputAddress?: string;
}

/** Read a producer result payload that names a live session
 *  (`{session_id, event_stream_address|event_feed_address}`) into a stream handle,
 *  or null when it names no session. Keys PURELY off the presence of its own fields
 *  — no status-enum gate (the generic poll rail already decided this payload is
 *  non-terminal via the `complete:false` boolean before handing it here). The caller
 *  hands us the OPAQUE payload — it never reads these fields itself. */
export function readProcessSessionStreamHandle(payload: Record<string, unknown>): ProcessSessionStreamHandle | null {
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const streamAddress =
    typeof payload.event_stream_address === 'string' && payload.event_stream_address.length > 0
      ? payload.event_stream_address
      : undefined;
  const feedAddress =
    typeof payload.event_feed_address === 'string' && payload.event_feed_address.length > 0
      ? payload.event_feed_address
      : undefined;
  // hop1 reads the HEAD/feed (state + bytesWritten). Prefer the feed; fall back to
  // the stream when a producer supplied only that (older two-hop discovery still works).
  const liveFeedAddress = feedAddress ?? streamAddress ?? null;
  if (!liveFeedAddress) return null;
  const terminalOutputAddress =
    typeof payload.terminal_output_address === 'string' && payload.terminal_output_address.length > 0
      ? payload.terminal_output_address
      : undefined;
  const rawSpec = payload.stream_parse_spec;
  const spec = rawSpec && typeof rawSpec === 'object' && !Array.isArray(rawSpec)
    && Array.isArray((rawSpec as { events?: unknown }).events)
    ? (rawSpec as unknown as StreamTextSpec)
    : undefined;
  return {
    sessionId,
    liveFeedAddress,
    ...(streamAddress ? { streamAddress } : {}),
    ...(terminalOutputAddress ? { terminalOutputAddress } : {}),
    ...(spec ? { textSpec: spec } : {}),
  };
}

/** Per-session monotonic PROGRESS GUARD for a live session's output.
 *
 * The delta fold that feeds a session's growing text can RESET mid-session (the
 * store re-inits its accumulator when the stream-param identity changes, and a
 * cell tears down when an exited session stops being written). A reset blanks the
 * text to '' and drops the completeness signal — so a naive consumer sees the
 * streamed answer VANISH and its finalize gate fall back to false before it fires,
 * losing the answer.
 *
 * Session output is APPEND-ONLY, so the LONGEST text seen is always the most
 * complete; this guard retains it (never regressing to a shorter reset artifact)
 * and LATCHES completeness (once true it stays true for the session). Both are
 * idempotent max/OR folds, so a consumer can call this every render with the
 * current `{ text, rawComplete }` and always read back the best-known state.
 * It NEVER fabricates or truncates text — it only refuses to blank progress.
 * On a new `sessionId` the guard resets. */
export function foldSessionProgressGuard(
  prev: { sessionId: string | null; text: string; complete: boolean },
  next: { sessionId: string | null; text: string; rawComplete: boolean },
): { sessionId: string | null; text: string; complete: boolean } {
  const base = prev.sessionId === next.sessionId
    ? prev
    : { sessionId: next.sessionId, text: '', complete: false };
  return {
    sessionId: next.sessionId,
    text: next.text.length > base.text.length ? next.text : base.text,
    complete: base.complete || next.rawComplete,
  };
}
