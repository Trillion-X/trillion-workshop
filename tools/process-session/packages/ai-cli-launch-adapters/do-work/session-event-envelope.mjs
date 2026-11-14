// packages/ai-cli-launch-adapters/do-work/session-event-envelope.mjs
//
// =============================================================================
// PURPOSE: the ADDRESS and the ENVELOPE for one chat-session lifecycle event
// =============================================================================
//
// This is the half of session-event emission that a DERIVATION may run. A
// derivation is an entry the engine runs against the log, so what it computes
// has to be reproducible from the log alone. Everything here is a pure function
// of its arguments: same arguments in, same bytes out, on any machine on any day.
//
// Its sibling emit-session-event.mjs is the OTHER half: a spawned CLI hook that
// observes a session's lifecycle from outside the engine. That process reads a
// clock, an environment, a sequence file and the network, and for an observer
// those are inputs the log records, exactly like a date a person typed. It calls
// into this module and supplies what it observed.
//
// The split is the point. Before it, one module served both callers and so held
// the union of both callers' powers, which handed a derivation an observer's
// clock.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
//  1. No clock, no generator, no environment, no file access, no network. Every
//     fact arrives as an argument.
//  2. `ts` and `path_labels` are REQUIRED. A default for either would put the
//     observer's world back inside the derivation, silently, at the one call
//     site that forgot to pass it.
//  3. Nothing here may import emit-session-event.mjs. The direction is one way.
//
// =============================================================================
// ENVELOPE SHAPE (what trigger-rules match on)
// =============================================================================
//   address:  session::event::<session_id>::<seq>   (address_mode identity_text)
//   path:     ['current-item', 'session-event']      (DATA, supplied by caller)
//   payload:  { kind:'session-event', event_kind, session_id, provider_ref,
//               tool_name?, prompt_ref?, contract_ref?, ts }
// A trigger-rule matches `address_text starts_with "session::event"` plus
// `payload.event_kind equals "<kind>"`. The path's FIRST segment (`current-item`)
// is the lane the trigger-engine delta subscription watches (live-proven for
// the clock: a tick on [current-item, ...] fired the chain, one on [clock,tick]
// did not); the SECOND segment (`session-event`) is the `find-current-items`
// read-back scope (`in:'session-event'`).

export const EVENT_KINDS = Object.freeze([
  'session-start',
  'message-submit',
  'tool-use',
  'session-stop',           // CLI session ended (fires T7-B continue)
  'session-stop-requested', // operator Stop control (fires T8 pause); a DISTINCT kind so it never triggers T7-B continue
  'session-error',
  'readback-blocked',       // native identity/readback failed; audit/liveness evidence, never delivery proof
]);

export const SESSION_EVENT_ADDRESS_PREFIX = 'session::event';

/** The lane a caller uses when nothing configured one. Exported as DATA rather than
 *  reached for, so a derivation names it and the hook can still override it. */
export const DEFAULT_SESSION_EVENT_PATH_LABELS = Object.freeze(['current-item', 'session-event']);

const WRITE_BATCH_OPERATION = 'engine.operation.write-batch';

function nonEmpty(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

/** The canonical labelled address for a (session, seq) pair. */
export function sessionEventAddress(sessionId, seq) {
  const id = nonEmpty(sessionId);
  if (!id) throw new Error('session_id is required');
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`seq must be a non-negative integer, got ${seq}`);
  if (id.includes('::')) throw new Error('session_id must not contain "::"');
  return `${SESSION_EVENT_ADDRESS_PREFIX}::${id}::${seq}`;
}

/**
 * Build the exact write-batch op for one lifecycle event. Pure: no IO, no clock.
 * `ts` is the instant the event happened, supplied by whoever knew it: the runtime
 * context for a derivation, the observing process for the CLI hook.
 */
export function buildSessionEventWrite({
  event_kind,
  session_id,
  seq,
  provider_ref,
  tool_name,
  prompt_ref,
  contract_ref,
  ts,
  partition_label,
  path_labels,
}) {
  if (!EVENT_KINDS.includes(event_kind)) {
    throw new Error(`unknown event_kind "${event_kind}" (expected one of ${EVENT_KINDS.join(', ')})`);
  }
  const partition = nonEmpty(partition_label);
  if (!partition) throw new Error('partition_label is required');
  const instant = nonEmpty(ts);
  if (!instant) throw new Error('ts is required: this builder never reads a clock of its own');
  const labels = Array.isArray(path_labels) ? path_labels.filter(Boolean) : [];
  if (labels.length === 0) throw new Error('path_labels is required and must name at least one lane');
  const address = sessionEventAddress(session_id, seq);
  const payload = {
    kind: 'session-event',
    event_kind,
    session_id: nonEmpty(session_id),
    provider_ref: nonEmpty(provider_ref) || 'unknown',
    ts: instant,
  };
  // Optional per-kind fields, present ONLY when supplied (never null keys).
  const toolName = nonEmpty(tool_name);
  if (toolName) payload.tool_name = toolName;
  const promptRef = nonEmpty(prompt_ref);
  if (promptRef) payload.prompt_ref = promptRef;
  const contractRef = nonEmpty(contract_ref);
  if (contractRef) payload.contract_ref = contractRef;

  return {
    operation_label: WRITE_BATCH_OPERATION,
    partition_label: partition,
    writes: [
      {
        partition_label: partition,
        address_label: address,
        address_mode: 'identity_text',
        path_labels: labels,
        payload,
      },
    ],
  };
}
