// tools/retire-a-copied-ai-reply/do-work/retire-a-copied-ai-reply.mjs
//
// tool:retire-a-copied-ai-reply: an AI sometimes records a reply by hand (record_messages) before the transcript hook keeps
// the same reply. This keeps the source-backed row and its links, and retires only an exact manual copy, after checking both
// rows and their nearby times. The run reads no store and writes none: the caller hands in the rows it read ([{ id, type,
// value }]: the two messages, and the thread index row when one exists) and gets back the rows that change under `keep`
// ([{ id, type, value, expected }], value null retires a row). A store refuses a keep whose `expected` has moved since it was read.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonical } from '../../decide-with-a-method/read-data/decision-records.mjs';

const TYPE = 'message';
const THREAD_TYPE = 'message-thread-index';
const CORRECTION_TYPE = 'message-duplicate-correction';
const NEARBY_MS = 120_000;

const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function refuse(words) {
  throw new Error(words);
}

/** The kept reply, with the manual copy's links added to it (none when it has no new links). */
function withNewLinks(kept, about) {
  if (!kept || !about?.length) return null;
  const has = new Set((kept.about ?? []).map(link => `${link.kind}\n${link.id}`));
  const extra = about.filter(link => !has.has(`${link.kind}\n${link.id}`));
  return extra.length ? [...(kept.about ?? []), ...extra] : null;
}

function threadIdentity(message) {
  return bytesToHex(blake3(new TextEncoder().encode(canonical({ app: message.app, conversation_id: message.conversation_id })))).slice(0, 24);
}

/** The id of the thread index row a copy is listed under. */
export function threadIdOf(duplicate, duplicateId) {
  return `${THREAD_TYPE}:${duplicate.at}:${threadIdentity(duplicate)}:${duplicateId.slice(-24)}`;
}

function recordsIn(input) {
  if (!Array.isArray(input?.records)) refuse('records must be the list of rows read from the store: [{ id, type, value }].');
  return input.records;
}

/** Retires the exact manual copy `duplicate_id` of the source-backed reply `kept_id`; answers the same correction again. */
export function retireCopiedAiReply(input) {
  const { duplicate_id, kept_id, evidence } = input ?? {};
  if (!nonempty(duplicate_id) || !nonempty(kept_id) || duplicate_id === kept_id || !nonempty(evidence))
    refuse('Two different message IDs and source evidence are required.');
  const records = recordsIn(input);
  const read = id => records.find(row => row.id === id)?.value ?? null;
  const correctionId = `${CORRECTION_TYPE}:${duplicate_id}`;
  const previous = read(correctionId);
  if (previous) {
    if (previous.kept_id !== kept_id || previous.evidence !== evidence) refuse('This duplicate already has a different correction.');
    return { correction: previous, keep: [] };
  }
  const duplicate = read(duplicate_id);
  const kept = read(kept_id);
  if (!duplicate || !kept || duplicate.speaker !== 'ai' || kept.speaker !== 'ai'
    || duplicate.source_ref || !kept.source_ref || duplicate.app !== kept.app
    || duplicate.conversation_id !== kept.conversation_id || duplicate.text !== kept.text
    || Math.abs(Date.parse(duplicate.at) - Date.parse(kept.at)) > NEARBY_MS)
    refuse('An exact nearby manual AI copy and a source-backed AI reply are required.');
  const about = withNewLinks(kept, duplicate.about);
  const correction = { duplicate_id, kept_id, evidence, corrected_at: new Date(input.now ?? Date.now()).toISOString(), duplicate };
  const threadId = threadIdOf(duplicate, duplicate_id);
  const thread = read(threadId);
  const keep = [
    ...(about ? [{ id: kept_id, type: TYPE, value: { ...kept, about }, expected: kept }] : []),
    { id: duplicate_id, type: TYPE, value: null, expected: duplicate },
    ...(thread ? [{ id: threadId, type: THREAD_TYPE, value: null, expected: thread }] : []),
    { id: correctionId, type: CORRECTION_TYPE, value: correction, expected: null },
  ];
  return { correction, keep };
}
