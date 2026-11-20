// tools/correct-a-message-recorded-as-the-person/do-work/correct-a-message-recorded-as-the-person.mjs
//
// tool:correct-a-message-recorded-as-the-person: a message kept as the person's own words was really said by a diagnostic,
// a peer or generated context. The corrected message keeps its text and time under a new id, and the false row, its arrival
// rows and its thread index row are retired, with the evidence. The run reads no store and writes none: the caller hands in
// the rows it read ([{ id, type, value }]: the message, its arrival rows and its thread index row when one exists) and gets
// back the rows that change under `keep` ([{ id, type, value, expected }], value null retires a row). A store refuses a keep
// whose `expected` has moved since it was read.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonical } from '../../decide-with-a-method/read-data/decision-records.mjs';

const TYPE = 'message';
const THREAD_TYPE = 'message-thread-index';
const ARRIVAL_TYPE = 'arrival';
const CORRECTION_TYPE = 'message-provenance-correction';
const SPEAKERS = ['sdk diagnostic', 'peer', 'generated context'];

const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function refuse(words) {
  throw new Error(words);
}

function recordsIn(input) {
  if (!Array.isArray(input?.records)) refuse('records must be the list of rows read from the store: [{ id, type, value }].');
  return input.records;
}

function threadIdentity(message) {
  return bytesToHex(blake3(new TextEncoder().encode(canonical({ app: message.app, conversation_id: message.conversation_id })))).slice(0, 24);
}

/** The id of a message row: its time order key, then the hash of its conversation, app, speaker, time and text. */
export function messageIdOf(message) {
  const order = message.clock
    ? `${new Date(message.clock.wall_ms).toISOString()}!${String(message.clock.logical).padStart(16, '0')}!${encodeURIComponent(message.clock.device_id)}`
    : message.at;
  const digest = bytesToHex(blake3(new TextEncoder().encode(canonical({
    conversation_id: message.conversation_id, app: message.app, speaker: message.speaker, at: message.at, text: message.text,
  })))).slice(0, 24);
  return `${TYPE}:${order}:${digest}`;
}

/** The id of the thread index row a message is listed under. */
export function threadIdOf(message, messageId) {
  return `${THREAD_TYPE}:${message.at}:${threadIdentity(message)}:${messageId.slice(-24)}`;
}

/** Corrects a kept person message to the speaker the evidence names; answers the same correction again. */
export function correctAMessageRecordedAsThePerson(input) {
  const { message_id, speaker, evidence } = input ?? {};
  if (!nonempty(message_id) || !SPEAKERS.includes(speaker) || !nonempty(evidence))
    refuse('message_id, speaker (sdk diagnostic, peer, or generated context), and source evidence are required.');
  const records = recordsIn(input);
  const read = id => records.find(row => row.id === id)?.value ?? null;
  const correctionId = `${CORRECTION_TYPE}:${message_id}`;
  const previous = read(correctionId);
  if (previous) {
    if (previous.speaker !== speaker || previous.evidence !== evidence) refuse('This message already has a different provenance correction.');
    return { correction: previous, keep: [] };
  }
  const original = read(message_id);
  if (!original || original.speaker !== 'person') refuse('A currently kept person message is required.');
  const revised = { ...original, speaker };
  delete revised.recorded_at;
  const newId = messageIdOf(revised);
  const arrivals = records.filter(row => row.type === ARRIVAL_TYPE && row.value?.message_id === message_id).map(row => row.id);
  const threadId = threadIdOf(original, message_id);
  const thread = read(threadId);
  const correctedAt = new Date(input.now ?? Date.now()).toISOString();
  const correction = { message_id, corrected_message_id: newId, speaker, evidence, corrected_at: correctedAt, original, retired_arrival_ids: arrivals };
  const keep = [
    { id: newId, type: TYPE, value: { ...revised, recorded_at: original.recorded_at, corrected_from: message_id }, expected: null },
    { id: message_id, type: TYPE, value: null, expected: original },
    ...(thread ? [{ id: threadId, type: THREAD_TYPE, value: null, expected: thread }] : []),
    ...arrivals.map(id => ({ id, type: ARRIVAL_TYPE, value: null, expected: records.find(row => row.id === id).value })),
    { id: correctionId, type: CORRECTION_TYPE, value: correction, expected: null },
  ];
  return { correction, keep };
}
