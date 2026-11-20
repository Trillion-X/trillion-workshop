// tools/correct-when-a-message-was-written/do-work/correct-when-a-message-was-written.mjs
//
// tool:correct-when-a-message-was-written: a message the person kept without its original time (an older chat recorded later)
// keeps its message id and every link, and shows when the person actually wrote it, with the evidence. The time is checked once
// by the same rule every given time follows (keep-and-wake src/claimed-time.mjs): any past time, never one ahead of the clock.
// The run reads no store and writes none: the caller hands in the rows it read ([{ id, type, value }]: the message and any
// earlier time correction) and gets back the rows that change under `keep` ([{ id, type, value, expected }]).
import { claimedTime } from '../../keep-and-wake-ai-sessions-on-this-computer/src/claimed-time.mjs';

const TYPE = 'message';
const CORRECTION_TYPE = 'message-time-correction';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function refuse(words) {
  throw new Error(words);
}

function recordsIn(input) {
  if (!Array.isArray(input?.records)) refuse('records must be the list of rows read from the store: [{ id, type, value }].');
  return input.records;
}

/** Shows the exact time the person wrote a kept message; answers the same correction again. */
export function correctWhenAMessageWasWritten(input) {
  const { message_id, authored_at, evidence } = input ?? {};
  if (!nonempty(message_id) || !nonempty(evidence) || typeof authored_at !== 'string' || Number.isNaN(Date.parse(authored_at)))
    refuse('message_id, authored_at, and source evidence are required.');
  const now = new Date(input.now ?? Date.now());
  claimedTime(authored_at, { now, field: 'authored_at', make: refuse });
  const records = recordsIn(input);
  const read = id => records.find(row => row.id === id)?.value ?? null;
  const original = read(message_id);
  if (!original || original.speaker !== 'person') refuse('A kept person message is required.');
  const exact = new Date(authored_at).toISOString();
  if (Date.parse(exact) > Date.parse(original.at)) refuse('Authored time cannot follow the stored capture time.');
  const correctionId = `${CORRECTION_TYPE}:${message_id}`;
  const previous = read(correctionId);
  if (previous) {
    if (previous.authored_at !== exact || previous.evidence !== evidence) refuse('This message already has a different time correction.');
    return { correction: previous, keep: [] };
  }
  const correction = { message_id, authored_at: exact, captured_at: original.at, evidence, corrected_at: now.toISOString() };
  const keep = [
    { id: message_id, type: TYPE, value: { ...original, authored_at: exact, captured_at: original.at }, expected: original },
    { id: correctionId, type: CORRECTION_TYPE, value: correction, expected: null },
  ];
  return { correction, keep };
}
