// computer/meeting-ledger.mjs
//
// Purpose
//   What the listener on this Mac (computer/listen.mjs) says about a listening: a listening whose heartbeat is old reads as
//   finished without any sweep, a line that is only text a hearing model makes up out of silence is told apart, and the typed
//   state of the notes job is told in plain words. All numbers, names and words are meeting-ledger.json.
//
// Non-negotiable invariants
//   1. Liveness is decided when read, from the heartbeat's age; nothing sweeps and nothing is rewritten to mark a session over.
//   2. A line that is only text a hearing model makes up out of silence (false_text) is left out, never sent.
//
import data from './meeting-ledger.json' with { type: 'json' };

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const plain = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

/** Whether a whole line is only text a hearing model makes up out of silence (false_text). */
export function isFalseText(text, rows = data) {
  const said = plain(text);
  if (!said) return true;
  if (said.split(' ').length > rows.false_text.max_words) return false;
  return rows.false_text.phrases.some(phrase => said === plain(phrase));
}

// ---- Liveness ----------------------------------------------------------------------------------------------------

/** Whether a listening is live: its status says listening and its heartbeat is not older than liveness.stale_after_ms. */
export function livenessOf(status, now = Date.now(), rows = data) {
  if (!status?.listening) return { live: false, why: 'off' };
  const beat = Number(status.heartbeat_ms);
  if (!Number.isFinite(beat)) return { live: true, why: 'no heartbeat recorded' };
  const age = now - beat;
  return age > rows.liveness.stale_after_ms ? { live: false, why: 'stale', age_ms: age } : { live: true, why: 'beating', age_ms: age };
}

// ---- The notes job's state ---------------------------------------------------------------------------------------

/** The plain sentence and the controls of a notes-job state ({ state, why? }). */
export function jobState(state, why = '', rows = data) {
  const row = rows.job_states[state];
  if (!row) return { state, says: String(state), controls: [] };
  return { state, says: fill(row.says, { why }), controls: row.controls };
}
