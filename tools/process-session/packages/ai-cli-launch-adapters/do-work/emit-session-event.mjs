// packages/ai-cli-launch-adapters/do-work/emit-session-event.mjs
//
// =============================================================================
// PURPOSE: turn ONE chat-session lifecycle event into ONE engine envelope
// =============================================================================
//
// The affirmative twin of the clock waiter in notice-when-something-shows-up,
// which turns wall-clock into `clock::tick` envelopes; this module turns a chat
// session's lifecycle into
// `session::event::<session_id>::<seq>` envelopes. Its admitted package target
// and mounted co-consumers emit those envelopes, so downstream guards and loops
// are DATA trigger-rules instead of files an agent must remember to arm.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
//  1. ZERO harness logic. No rule, no guard, no loop, no allocation, no provider
//     branch. Lifecycle in, envelope out. (A naive agent puts guard logic here,
//     which is the god-package error.)
//  2. NEVER crash the launch. Every failure (bad port, dead engine, network) is
//     caught; the event is buffered to disk and the process exits 0. A hook that
//     exits non-zero can block the host CLI, so this exits 0 unconditionally.
//  3. Transport is co-mounted stored bytes. The leaf has no cross-package import;
//     workflows mount send-requests-to-running-app.mjs beside this source.
//  4. Idempotent by address. The address `session::event::<id>::<seq>` is written
//     last-writer-wins (identity_text write-batch), so re-emitting the same
//     (session_id, seq) overwrites in place and a duplicate seq is a no-op.
//  5. Every knob is DATA. Path lane, partition, target URL, and seq are env/DATA,
//     never hardcoded product values.
//
// =============================================================================
// ENVELOPE SHAPE (what trigger-rules match on)
// =============================================================================
//   address:  session::event::<session_id>::<seq>   (address_mode identity_text)
//   path:     ['current-item', 'session-event']      (DATA: BITFIELD_SESSION_EVENT_PATH)
//   payload:  { kind:'session-event', event_kind, session_id, provider_ref,
//               tool_name?, prompt_ref?, contract_ref?, ts }
// A trigger-rule matches `address_text starts_with "session::event"` plus
// `payload.event_kind equals "<kind>"`. The path's FIRST segment (`current-item`)
// is the lane the trigger-engine delta subscription watches (live-proven for
// the clock: a tick on [current-item, ...] fired the chain, one on [clock,tick]
// did not); the SECOND segment (`session-event`) is the `find-current-items`
// read-back scope (`in:'session-event'`).

import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// The address and envelope live in session-event-envelope.mjs, which is PURE: no clock,
// no environment, no network, no file access. That module is what the admitted target
// (a derivation) runs. This module is the OBSERVER half, and everything it reaches for
// below is an observation it supplies INTO that builder as an argument.
// Re-exported so every existing importer of this file keeps resolving.
export {
  buildSessionEventWrite,
  DEFAULT_SESSION_EVENT_PATH_LABELS,
  EVENT_KINDS,
  SESSION_EVENT_ADDRESS_PREFIX,
  sessionEventAddress,
} from './session-event-envelope.mjs';

import { buildSessionEventWrite, DEFAULT_SESSION_EVENT_PATH_LABELS } from './session-event-envelope.mjs';

const WRITE_TARGET = 'engine.operation.label-addressed';
const RUNNING_APP_REQUESTS_MODULE = './send-requests-to-running-app.mjs';
function nonEmpty(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

/** Split a comma-separated path-label env into an array (DATA-configured lane). */
export function resolvePathLabels(env = process.env) {
  const raw = nonEmpty(env.BITFIELD_SESSION_EVENT_PATH);
  if (!raw) return [...DEFAULT_SESSION_EVENT_PATH_LABELS];
  const labels = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (labels.length === 0) throw new Error('BITFIELD_SESSION_EVENT_PATH resolved to zero path labels');
  return labels;
}

// ---------------------------------------------------------------------------
// PURE: target, partition, and seq resolution (env/DATA, never hardcoded)
// ---------------------------------------------------------------------------

/** Resolve the caller-selected running-app URL plus partition DATA. */
export function resolveEmitterTarget(env = process.env) {
  const explicitUrl = nonEmpty(env.BITFIELD_SESSION_EVENT_SHELL_URL)
    ?? nonEmpty(env.BITFIELD_SHELL_URL)
    ?? nonEmpty(env.BITFIELD_TARGET_CARRIER_URL)
    ?? normalizeAddress(nonEmpty(env.BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS))
    ?? (nonEmpty(env.PORT) ? `http://127.0.0.1:${nonEmpty(env.PORT)}` : null);

  const partition = nonEmpty(env.BITFIELD_SESSION_EVENT_PARTITION)
    ?? nonEmpty(env.BITFIELD_PARTITION);

  if (!explicitUrl || !partition) return null;
  return { url: explicitUrl, partition };
}

function normalizeAddress(address) {
  if (!address) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `http://${address}`;
}

/** Stable per-engine key for buffer/seq state files (url plus partition identity). */
export function engineKey(url, partition) {
  return createHash('sha256')
    .update(String(url || 'no-url'))
    .update('\0')
    .update(String(partition || 'default'))
    .digest('hex')
    .slice(0, 24);
}

function seqStateFile(sessionId) {
  const key = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32);
  return path.join(os.tmpdir(), `session-event-seq-${key}.json`);
}

/**
 * Resolve the monotonic seq for this event. Explicit `BITFIELD_SESSION_EVENT_SEQ`
 * wins (lets a caller assert idempotency or drive an exact seq). Otherwise read
 * and increment a per-session tmp counter so hook callers need not track it.
 */
export function nextSeq(sessionId, env = process.env, io = {}) {
  const explicit = nonEmpty(env.BITFIELD_SESSION_EVENT_SEQ);
  if (explicit != null) {
    const n = Number(explicit);
    if (!Number.isInteger(n) || n < 0) throw new Error(`BITFIELD_SESSION_EVENT_SEQ must be a non-negative integer, got ${explicit}`);
    return n;
  }
  const file = io.seqStateFile ? io.seqStateFile(sessionId) : seqStateFile(sessionId);
  const readFile = io.readFileSync ?? readFileSync;
  const writeFile = io.writeFileSync ?? writeFileSync;
  const fileExists = io.existsSync ?? existsSync;
  let current = -1;
  if (fileExists(file)) {
    try { current = Number(JSON.parse(readFile(file, 'utf8')).seq); } catch { current = -1; }
    if (!Number.isInteger(current)) current = -1;
  }
  const next = current + 1;
  try { writeFile(file, JSON.stringify({ seq: next, session_id: sessionId })); } catch { /* best-effort */ }
  return next;
}

// ---------------------------------------------------------------------------
// IO: basis fetch, POST, buffering (never throws to the caller)
// ---------------------------------------------------------------------------

function runningAppRequests() {
  return import(RUNNING_APP_REQUESTS_MODULE);
}

async function postWriteOp(url, writeOp, fetchImpl = fetch, requestsOverride = null) {
  let requests = requestsOverride ?? await runningAppRequests();
  if (typeof requests === 'function') requests = await requests();
  const session = await requests.startRunningAppSession({ url, fetchImpl });
  await requests.sendRequestWithBasisRefresh(session, WRITE_TARGET, writeOp, { fetchImpl });
  return { ok: true };
}

function bufferFile(key) {
  return path.join(os.tmpdir(), `session-event-buffer-${key}.jsonl`);
}

function bufferWriteOp(key, writeOp, io = {}) {
  const append = io.appendFileSync ?? appendFileSync;
  try { append(bufferFile(key), `${JSON.stringify(writeOp)}\n`); return true; } catch { return false; }
}

/** Best-effort flush of any buffered ops once the engine is reachable again. */
async function flushBuffer(url, key, fetchImpl = fetch, io = {}, requestsOverride = null) {
  const file = bufferFile(key);
  const fileExists = io.existsSync ?? existsSync;
  const readFile = io.readFileSync ?? readFileSync;
  const remove = io.unlinkSync ?? unlinkSync;
  if (!fileExists(file)) return 0;
  let lines;
  try { lines = readFile(file, 'utf8').split('\n').filter(Boolean); } catch { return 0; }
  let flushed = 0;
  for (const line of lines) {
    let op;
    try { op = JSON.parse(line); } catch { continue; }
    try { await postWriteOp(url, op, fetchImpl, requestsOverride); flushed += 1; } catch { return flushed; } // stop on first failure, keep buffer
  }
  try { remove(file); } catch { /* best-effort */ }
  return flushed;
}

/**
 * Emit one session event. NEVER throws. Returns a machine-readable result.
 * On an unreachable or dead engine the event is buffered and { buffered:true } is
 * returned so the launch keeps going (acceptance criterion 3).
 */
export async function emitSessionEvent(context, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const io = options.io ?? {};
  const requestsOverride = options.runningAppRequests ?? null;
  const log = options.log ?? ((msg) => console.error(msg));

  // No invented fallback. A session id derived from the clock names no session, so every
  // event under it is uncorrelatable, which is worse than the rejection below.
  const sessionId = nonEmpty(context.session_id) ?? nonEmpty(env.BITFIELD_SESSION_ID);
  if (!sessionId) {
    const error = 'session_id is required: pass it, or set BITFIELD_SESSION_ID';
    log(`[session-event] rejected ${context.event_kind}: ${error}`);
    return { ok: false, rejected: true, error };
  }
  const seq = Number.isInteger(context.seq) ? context.seq : nextSeq(sessionId, env, io);
  const target = options.target ?? resolveEmitterTarget(env, io);

  let writeOp;
  try {
    writeOp = buildSessionEventWrite({
      event_kind: context.event_kind,
      session_id: sessionId,
      seq,
      provider_ref: context.provider_ref ?? nonEmpty(env.BITFIELD_SESSION_PROVIDER_REF),
      tool_name: context.tool_name ?? nonEmpty(env.BITFIELD_SESSION_TOOL_NAME),
      prompt_ref: context.prompt_ref ?? nonEmpty(env.BITFIELD_SESSION_PROMPT_REF),
      contract_ref: context.contract_ref ?? nonEmpty(env.BITFIELD_SESSION_CONTRACT_REF),
      // This process WAS THERE when the event happened, so the instant is its observation
      // to make. The builder takes it as an argument and never reads a clock itself.
      ts: nonEmpty(context.ts) ?? new Date().toISOString(),
      partition_label: target?.partition ?? nonEmpty(env.BITFIELD_PARTITION),
      path_labels: resolvePathLabels(env),
    });
  } catch (error) {
    // A malformed call (bad event_kind) must not crash the launch either.
    log(`[session-event] rejected ${context.event_kind}: ${error.message}`);
    return { ok: false, rejected: true, error: error.message };
  }

  if (!target?.url) {
    const key = engineKey(null, writeOp.partition_label);
    const buffered = bufferWriteOp(key, writeOp, io);
    log(`[session-event] buffered ${context.event_kind} seq=${seq} session=${sessionId} (no engine target)`);
    return { ok: false, buffered, seq, session_id: sessionId, address: writeOp.writes[0].address_label };
  }

  const key = engineKey(target.url, target.partition);
  try {
    await postWriteOp(target.url, writeOp, fetchImpl, requestsOverride);
    const flushed = await flushBuffer(target.url, key, fetchImpl, io, requestsOverride);
    log(`[session-event] emitted ${context.event_kind} seq=${seq} session=${sessionId}${flushed ? ` (+${flushed} buffered)` : ''}`);
    return { ok: true, seq, session_id: sessionId, address: writeOp.writes[0].address_label, flushed };
  } catch (error) {
    const buffered = bufferWriteOp(key, writeOp, io);
    log(`[session-event] buffered ${context.event_kind} seq=${seq} session=${sessionId} (engine unreachable: ${error.message})`);
    return { ok: false, buffered, seq, session_id: sessionId, address: writeOp.writes[0].address_label, error: error.message };
  }
}
