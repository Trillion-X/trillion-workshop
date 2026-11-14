import { sendRequestToBitfieldTarget, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';

type JsonRecord = Record<string, unknown>;
type Sender = (request: unknown) => Promise<unknown>;
const decoder = new TextDecoder();
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): JsonRecord | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;

/** Browser intent only. Actor, time, item identity, owner targets, and event are server-owned. */
export function createGroupPost(input: { idempotencyRef: string; groupRef: string; fields: JsonRecord; expectedRevision?: number }) {
  if (!text(input.idempotencyRef) || !text(input.groupRef) || !record(input.fields)) return Promise.reject(new Error('invalid group item request'));
  return sendRequestToBitfieldTarget({ target: 'group-page.share-item', payload: { subject_ref: input.groupRef, fields: clone(input.fields), expected_revision: input.expectedRevision ?? 0, idempotency_ref: input.idempotencyRef } });
}

export function readGroupPosts(groupRef: string) {
  if (!text(groupRef)) return Promise.reject(new Error('invalid group item read request'));
  return sendRequestToBitfieldTarget({ target: 'group-page.share-item', payload: { subject_ref: groupRef, operation: 'read-items', expected_revision: 0, idempotency_ref: `read-items:${groupRef}` } });
}

async function admitted(input: unknown, sender: Sender) {
  const wrapped = record(input); const payload = record(wrapped?.payload); const actor = record(wrapped?.ambient_actor); const decision = record(wrapped?.access_decision); const revisions = record(decision?.revisions);
  const admissionFailures = [
    !payload && 'payload',
    !actor && 'ambient-actor',
    !decision && 'access-decision',
    !revisions && 'decision-revisions',
    decision?.decision !== 'allow' && 'allow-decision',
    actor && decision && text(actor.actor_ref) !== text(decision.actor_ref) && 'actor-binding',
    actor && decision && text(actor.session_ref) !== text(decision.session_ref) && 'session-binding',
    actor && revisions && text(actor.session_revision) !== text(revisions.session_revision) && 'session-revision-binding',
    payload && decision && text(payload.subject_ref) !== text(decision.subject_ref) && 'subject-binding',
  ].filter((failure): failure is string => typeof failure === 'string');
  if (admissionFailures.length) throw new Error(`server admission is required and must be current (${admissionFailures.join(', ')})`);
  const verified = jsonReply(await sender({ target: 'access-rule.verify-decision', payload: { decision_proof: decision.decision_proof, actor_ref: actor.actor_ref, session_ref: actor.session_ref, subject_ref: payload.subject_ref, action_ref: 'group-page.share-item', revisions } })); const durable = record(verified?.decision);
  if (verified?.verified !== true || !durable || text(durable.actor_ref) !== text(actor.actor_ref) || text(durable.subject_ref) !== text(payload.subject_ref)) throw new Error('server admission is not durable or does not authorize this owner action');
  const durableRevisions = record(durable.revisions);
  const admittedActor = { actor_ref: durable.actor_ref, session_ref: durable.session_ref, session_revision: durableRevisions?.session_revision };
  return { payload, actor: admittedActor, decision: durable };
}
function ownerRequest(payload: JsonRecord, actor: JsonRecord, decision: JsonRecord) { return { payload, ambient_actor: actor, access_decision: decision }; }
function replyBytes(reply: unknown): Uint8Array { if (reply instanceof Uint8Array) return reply; if (reply instanceof ArrayBuffer) return new Uint8Array(reply); if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength); const payload = record(reply)?.payload; if (payload === undefined) throw new Error('target reply did not include bytes'); return replyBytes(payload); }
function jsonReply(reply: unknown): JsonRecord { if (reply instanceof Uint8Array || reply instanceof ArrayBuffer || ArrayBuffer.isView(reply)) { const value = record(JSON.parse(decoder.decode(replyBytes(reply)))); if (!value) throw new Error('target reply must be an object'); return value; } const outer = record(reply); if (!outer) throw new Error('target reply must be an object'); const payload = outer.payload; if (payload instanceof Uint8Array || payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) { const value = record(JSON.parse(decoder.decode(replyBytes(payload)))); if (!value) throw new Error('target reply must be an object'); return value; } return outer; }
function accepted(reply: unknown, label: string) { const value = jsonReply(reply); if (value.status !== 'accepted' || value.conflict === true) throw new Error(`${label} did not accept the owner action`); return value; }
async function ownerStage<Value>(label: string, run: () => Promise<Value>): Promise<Value> { try { return await run(); } catch (error) { throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`); } }
async function emitAcceptedEvent(subjectRef: string, idempotencyRef: string, actorRef: string, row: JsonRecord, sender: Sender) {
  const eventRef = `owner-accepted:${subjectRef}:${idempotencyRef}`; const occurredAt = text(row.updated_at); const revision = Number(row.revision); if (!occurredAt || !Number.isSafeInteger(revision) || revision < 1) throw new Error('item readback cannot support an accepted event');
  const signed = jsonReply(await sender({ target: 'signed-event-author.sign-event', payload: { payload: { event_id: eventRef, namespace: 'owner-action', occurred_at: occurredAt, idempotency_key: eventRef, supersedes: [], facts: [{ fact_id: `${eventRef}:mutation`, subject: actorRef, relation: 'owner-action.accepted', object: 'group-page.share-item', attributes: { subject_ref: subjectRef, owner_ref: text(row.item_ref), owner_revision: revision, idempotency_ref: idempotencyRef } }] } } }));
  const authority = jsonReply(await sender({ target: 'signed-event-authority.admit-event', payload: { body: { events: [signed] }, request_id: eventRef } })); const hashes = record(record(authority.evaluation)?.event_hashes); const eventHash = text(hashes?.[eventRef]); if (!eventHash) throw new Error('signed accepted event was not admitted');
  await sender({ target: 'slot::workflow', payload: { operation: 'execute_definition', definition_id: 'action:owner-action-event-log.record-owner-action-event', include_output: true, input: { event: signed, canonical_hash: eventHash } } });
  return { event_ref: eventRef, event_hash: eventHash };
}

/** One generic share doorway: opaque item fields become an item-owner row and accepted event. */
export async function shareGroupItemTarget(input: unknown, _context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  const { payload, actor, decision } = await admitted(input, sender); const subjectRef = text(payload.subject_ref); const operation = text(payload.operation) || 'share-item';
  if (!subjectRef || (operation !== 'share-item' && operation !== 'read-items')) throw new Error('invalid group item request');
  if ('actor_ref' in payload || 'item_ref' in payload || 'target_ref' in payload || 'owner_target' in payload || 'event' in payload || 'created_at' in payload) throw new Error('group item doorway derives actor, identity, owner targets, event, and time');
  const actorRef = text(actor.actor_ref); const participationRef = `participant:${actorRef}`;
  const participation = accepted(await ownerStage('participant owner readback', () => sender({ target: 'subject-participant.read-subject-participants', payload: ownerRequest({ subject_ref: subjectRef, participations: [{ participation_ref: participationRef }] }, actor, decision) })), 'participant owner readback');
  const participantRows = Array.isArray(participation.rows) ? participation.rows.map(record).filter((row): row is JsonRecord => Boolean(row)) : [];
  if (!participantRows.some((row) => text(row.participation_ref) === participationRef && text(row.actor_ref) === actorRef && row.removed !== true)) throw new Error('current subject participation is required to share an item');
  if (operation === 'read-items') return accepted(await ownerStage('item owner scope read', () => sender({ target: 'item-record.read-space-items', payload: ownerRequest({ scope_ref: subjectRef, list_scope: true }, actor, decision) })), 'item owner scope read');
  const idempotencyRef = text(payload.idempotency_ref); const expectedRevision = Number(payload.expected_revision); const fields = record(payload.fields);
  if (!idempotencyRef || !fields || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid group item request');
  const itemRef = `group-item:${idempotencyRef}`;
  const mutation = accepted(await ownerStage('item owner mutation', () => sender({ target: 'item-record.record-space-items', payload: ownerRequest({ scope_ref: subjectRef, mutations: [{ item_ref: itemRef, target_ref: subjectRef, expected_revision: expectedRevision, idempotency_ref: idempotencyRef, fields: clone(fields) }] }, actor, decision) })), 'item owner');
  const readback = accepted(await ownerStage('item owner readback', () => sender({ target: 'item-record.read-space-items', payload: ownerRequest({ scope_ref: subjectRef, items: [{ item_ref: itemRef, target_ref: subjectRef }] }, actor, decision) })), 'item owner readback');
  const rows = Array.isArray(readback.rows) ? readback.rows.map(record).filter((row): row is JsonRecord => Boolean(row)) : []; const row = rows.find((entry) => text(entry.item_ref) === itemRef && text(entry.target_ref) === subjectRef); if (!row) throw new Error('shared item owner readback is missing');
  const event = await ownerStage('accepted-event emission', () => emitAcceptedEvent(subjectRef, idempotencyRef, actorRef, row, sender)); return { status: 'accepted', replay: mutation.replay === true, subject_ref: subjectRef, item_ref: itemRef, revision: Number(row.revision), row: clone(row), ...event };
}
