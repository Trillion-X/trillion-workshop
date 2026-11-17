// packages/service-connections/read-data/read-acquire-challenge-events.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// PURE lens: extract the interactive-acquire CHALLENGE from a live
// process-session event feed. An interactive acquire process (WhatsApp Baileys
// pairing shell, a QR-based connector, an oauth device-code poller) emits JSONL
// challenge lines on stdout mid-run — `{"type":"pairing_code","code":…}`,
// `{"type":"qr","qr":…}`, `{"type":"device_code","user_code":…,
// "verification_uri":…}` — while the process BLOCKS waiting for the user to act
// elsewhere. A bounded compute.process only returns stdout at COMPLETION (the
// resolve-then-show deadlock), so interactive acquires run via
// `compute.process_session`, whose event feed streams stdout bytes LIVE
// (process-session/read-data/read-process-session-events.ts) and which the UI
// already subscribes to reactively (`useBitfieldData
// liveProcessSessionEventFeeds` — the terminal precedent). This lens turns that
// byte feed into the one thing the connect dialog needs: "what should the user
// be shown right now?"
//
// Converged design (Codex GPT-5.5 high, 2026-07-04): live-status-over-an-address
// is the survivor; split-phase pairing is impossible for socket-live-state
// protocols (Baileys); child processes cannot write-batch mid-run — the
// process-session event feed IS the sanctioned live channel. See the
// whatsapp-instagram-connector plan §9.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. PURE: bytes in, challenge out. No React, no I/O, no vendor names — the
//    challenge KIND is whatever the process line declares (L090 self-describing
//    data; no closed vendor enum — an unknown challenge type still surfaces
//    with its raw fields).
// 2. Stdout arrives in arbitrary CHUNKS (a JSON line may span two output
//    events, or one event may carry many lines) — the lens reassembles the
//    byte stream and parses complete lines only.
// 3. The LATEST challenge wins (a re-offered pairing code replaces the stale
//    one); a `paired`/`connected`/`summary` line or session exit CLEARS the
//    challenge (the user acted — stop showing the code).
// 4. Non-JSON stdout lines (Baileys noise, logs) are ignored, never a crash.
// 5. An error LINE (`*_error`/`error`) is TRANSIENT, never terminal: an
//    interactive shell can fail one attempt and recover on the next rotation
//    (live-shell.mjs emits `pairing_code_error` inside a per-ref-rotation catch,
//    keeps the socket alive, and re-offers a fresh `pairing_code`). The lens only
//    REMEMBERS the last error reason; it never finishes the feed or clears the
//    challenge on an error line. The ONE terminal FAILURE signal is a real session
//    END with no completion — a `failed` state or a non-zero exit — which sets
//    `finished` + `error` and clears any stale challenge, so a genuinely dead
//    interactive step is always escapable / retryable (Q3) while a recovering one
//    is never killed prematurely.
import {
  readProcessSessionEventHead,
  readProcessSessionEventsFeed,
} from '../../process-session/read-data/read-process-session-events';

/** What the connect dialog should present for a live interactive acquire. */
export interface AcquireChallenge {
  /** Self-described challenge kind from the process line (e.g. 'pairing_code',
   *  'qr', 'device_code') — DATA, not an enum this lens interprets. */
  type: string;
  /** All fields of the challenge line verbatim (code / qr / user_code /
   *  verification_uri / phone / …) — the dialog picks what it renders. */
  fields: Record<string, unknown>;
}

export interface AcquireFeedView {
  /** The challenge the user should currently see, or null (none yet, or the
   *  process reported completion/exit/error — challenge consumed). */
  challenge: AcquireChallenge | null;
  /** True once the feed carries a terminal signal: a completion line
   *  (`summary`/`paired`/`connected`) or the session's exited/failed event. An
   *  error LINE alone does NOT finish the feed (it is transient — the shell may
   *  recover on the next rotation). A finished feed means the interactive step is
   *  over — the dialog stops showing the challenge and the surface either seals
   *  (success) or surfaces the error (failure). */
  finished: boolean;
  /** Exit code when the session ended (null while running / when unknown). */
  exitCode: number | null;
  /** The completion line's own fields verbatim (latest wins) — the process
   *  self-describes its outcome (paired / account / session_blob / counts;
   *  L090). Null until a completion line arrives. The seal path reads THIS,
   *  never re-parses stdout. */
  completion: Record<string, unknown> | null;
  /** Human-facing failure message when the interactive step genuinely FAILED —
   *  a `failed` session state, or a non-zero exit, that produced no completion.
   *  Its text is the last transient error line's reason (`*_error`/`error`, its
   *  `error`/`message` field) if one was seen, else a generic message. Null on
   *  the happy path AND while the shell is merely retrying (a transient error
   *  line with the session still alive). The dialog shows this + a retry
   *  affordance instead of a frozen stale challenge (Q3 — a failed pairing must
   *  always be escapable). */
  error: string | null;
}

/** Line types that mean "the interactive step is over — clear the challenge."
 *  These are the connector shells' own completion vocabulary (live-shell.mjs
 *  emits `summary`; connect flows may emit `paired`/`connected`). */
const COMPLETION_TYPES = new Set(['summary', 'paired', 'connected']);

/** Challenge-line predicate: any JSON line that ISN'T a completion/progress
 *  marker and carries at least one field beyond `type` is presentable. The
 *  known interactive kinds (pairing_code / qr / device_code) all satisfy this;
 *  a future kind does too — zero edits here (L069). */
function isChallengeLine(parsed: Record<string, unknown>): boolean {
  const type = parsed.type;
  if (typeof type !== 'string' || type.length === 0) return false;
  if (COMPLETION_TYPES.has(type)) return false;
  if (type.endsWith('_error') || type === 'error') return false;
  return Object.keys(parsed).length > 1;
}

/** Pull a human-facing message out of an error line's own fields (self-describing;
 *  no vendor enum). Tries the common field names, falls back to the raw type. */
function errorMessageOf(record: Record<string, unknown>): string {
  const candidate = record.error ?? record.message ?? record.reason ?? record.detail;
  if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  const type = typeof record.type === 'string' ? record.type : 'error';
  return `Connection failed (${type}).`;
}

/**
 * Fold a process-session event feed (the `liveProcessSessionEventFeeds` bytes)
 * into the current acquire view. Reassembles chunked stdout, parses complete
 * JSONL lines, keeps the LATEST challenge, clears it on completion or session
 * end. Error lines are transient (remembered, not terminal — invariant 5); the
 * only terminal FAILURE is a real session end (failed state / non-zero exit)
 * with no completion.
 */
export function readAcquireChallengeFeed(feedBytes: Uint8Array | ArrayBuffer): AcquireFeedView {
  const bytes = feedBytes instanceof Uint8Array ? feedBytes : new Uint8Array(feedBytes);
  const emptyView: AcquireFeedView = { challenge: null, finished: false, exitCode: null, completion: null, error: null };
  let feed;
  try {
    feed = readProcessSessionEventsFeed(bytes);
  } catch {
    return emptyView; // unreadable feed -> honest empty, never a crash
  }
  const chunks: Uint8Array[] = [];
  // Did the session end in the FAILED state (vs a clean 'exited')? A failed end
  // is terminal even with a null/zero exit code. Tracked separately from
  // exitCode so the terminal-failure decision below is exact.
  let sessionFailed = false;
  let finished = false;
  let sessionExitCode: number | null = null;
  feed.forEachEvent({
    onOutputBytes: (_sid, _n, _at, stream, out) => {
      if (stream === 'stdout' || stream === 'display') chunks.push(out);
    },
    onSessionStateChanged: (_sid, _n, _at, state, exitCode) => {
      if (state === 'exited' || state === 'failed') {
        finished = true;
        sessionExitCode = exitCode;
        if (state === 'failed') sessionFailed = true;
      }
    },
  });
  return interpretAcquireStdout(chunks, finished, sessionExitCode, sessionFailed);
}

/**
 * Discover the per-event delta-stream address from a V2 HEAD payload at the
 * feed address, or null for V1 payloads (which carry events inline).
 * The caller subscribes this address alongside the feed and folds each delta
 * through `createAcquireChallengeFold` — the accumulating counterpart of
 * `readAcquireChallengeFeed` for stream-of-single-event payloads.
 */
export function readAcquireEventStreamAddress(feedBytes: Uint8Array | ArrayBuffer): string | null {
  const bytes = feedBytes instanceof Uint8Array ? feedBytes : new Uint8Array(feedBytes);
  try {
    return readProcessSessionEventHead(bytes)?.eventStreamAddress ?? null;
  } catch {
    return null;
  }
}

/**
 * Stateful fold over V2 event-delta payloads: each call folds ONE payload's
 * events into the accumulated stdout stream and returns the same AcquireFeedView
 * the one-shot lens produces. Replayed/duplicate deltas (event_number ≤ last
 * folded) are skipped, so re-delivery is harmless. All parsing invariants
 * (chunk reassembly, complete-lines-only, latest-challenge-wins, transient
 * errors) are identical to `readAcquireChallengeFeed` — this fold just keeps
 * the byte accumulation across calls because a delta payload carries one event
 * instead of the whole history.
 */
export function createAcquireChallengeFold(): (payload: Uint8Array | ArrayBuffer) => AcquireFeedView {
  const chunks: Uint8Array[] = [];
  let lastFoldedEventNumber = 0;
  let finished = false;
  let exitCode: number | null = null;
  let sessionFailed = false;

  return (payload: Uint8Array | ArrayBuffer): AcquireFeedView => {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    try {
      readProcessSessionEventsFeed(bytes).forEachEvent({
        onOutputBytes: (_sid, eventNumber, _at, stream, out) => {
          if (eventNumber <= lastFoldedEventNumber) return;
          lastFoldedEventNumber = eventNumber;
          if (stream === 'stdout' || stream === 'display') chunks.push(out);
        },
        onSessionStateChanged: (_sid, eventNumber, _at, state, code) => {
          if (eventNumber <= lastFoldedEventNumber) return;
          lastFoldedEventNumber = eventNumber;
          if (state === 'exited' || state === 'failed') {
            finished = true;
            exitCode = code;
            if (state === 'failed') sessionFailed = true;
          }
        },
      });
    } catch {
      // Unreadable payload — keep the accumulated view, never crash.
    }
    return interpretAcquireStdout(chunks, finished, exitCode, sessionFailed);
  };
}

/** Shared line-interpretation core: reassemble stdout chunks, parse complete
 *  JSONL lines, apply the challenge/completion/error invariants. Used by both
 *  the one-shot full-feed lens and the V2 delta fold so the two paths can
 *  never diverge (SSOT). */
function interpretAcquireStdout(
  chunks: readonly Uint8Array[],
  finished: boolean,
  exitCode: number | null,
  sessionFailed: boolean,
): AcquireFeedView {
  const view: AcquireFeedView = { challenge: null, finished, exitCode, completion: null, error: null };
  let lastErrorMessage: string | null = null;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { joined.set(c, offset); offset += c.length; }
  const text = new TextDecoder().decode(joined);
  const endsComplete = text.endsWith('\n');
  const lines = text.split('\n');
  if (!endsComplete) lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.type === 'string' && COMPLETION_TYPES.has(record.type)) {
      view.finished = true;
      view.challenge = null;
      view.error = null;
      const { type: _completionType, ...completionFields } = record;
      view.completion = completionFields;
      continue;
    }
    if (typeof record.type === 'string' && (record.type.endsWith('_error') || record.type === 'error')) {
      lastErrorMessage = errorMessageOf(record);
      continue;
    }
    if (isChallengeLine(record)) {
      const { type, ...fields } = record;
      view.challenge = { type: type as string, fields };
    }
  }
  if (view.finished && view.challenge !== null) {
    view.challenge = null;
  }
  if (view.finished && view.completion === null && view.error === null
      && (sessionFailed || (view.exitCode !== null && view.exitCode !== 0))) {
    view.error = lastErrorMessage ?? 'Connection ended before it completed. Please try again.';
  }
  return view;
}
