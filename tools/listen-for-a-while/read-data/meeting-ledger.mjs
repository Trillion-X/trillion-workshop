// tools/listen-for-a-while/read-data/meeting-ledger.mjs
//
// Purpose
//   What the listener (read-data/listen-for-a-while.mjs) says about a listening: a line that is only text a hearing model
//   makes up out of silence is told apart, and the typed state of the notes job is told in plain words. All numbers, names and words are meeting-ledger.json.
//
// Non-negotiable invariants
//   1. A line that is only text a hearing model makes up out of silence (false_text) is left out, never sent.
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

// ---- The notes job's state ---------------------------------------------------------------------------------------

/** The plain sentence and the controls of a notes-job state ({ state, why? }). */
export function jobState(state, why = '', rows = data) {
  const row = rows.job_states[state];
  if (!row) return { state, says: String(state), controls: [] };
  return { state, says: fill(row.says, { why }), controls: row.controls };
}
