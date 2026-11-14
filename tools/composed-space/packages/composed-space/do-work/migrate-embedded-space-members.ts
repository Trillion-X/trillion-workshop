import {
  readTrustedRuntimeClockMs,
  readTrustedRuntimePartition,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  makeHashCodeHexFromBytes,
  type EngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';

type Sender = (request: unknown) => Promise<unknown>;
type JsonRecord = Record<string, unknown>;
type LegacyAggregate = { space_ref: string; scope_ref: string; revision: number; aggregate: JsonRecord };
type SuccessorPlan = { items: JsonRecord[]; participants: JsonRecord[]; relations: JsonRecord[]; successor_refs: string[]; migration_basis: string };
const encoder = new TextEncoder(); const decoder = new TextDecoder();
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): JsonRecord | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : record(value) ? `{${Object.keys(record(value)!).sort().map((key) => `${JSON.stringify(key)}:${canonical(record(value)![key])}`).join(',')}}` : JSON.stringify(value);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const hash = (value: unknown) => makeHashCodeHexFromBytes(encoder.encode(canonical(value)));
const legacyAddress = (spaceRef: string) => `package::composed-space::legacy-aggregate::${encodeURIComponent(spaceRef)}`;

const fixedOwnerTargets = Object.freeze({
  itemWrite: 'item-record.record-space-items', itemRead: 'item-record.read-space-items',
  participantWrite: 'subject-participant.upsert-participations', participantRead: 'subject-participant.read-subject-participants',
  relationWrite: 'content-media-evidence.record-relations', relationRead: 'content-media-evidence.read-relations',
});

/** Uses the Runtime Kit canonical multihash primitive; this module imports no Node-only digest API. */
export function deterministicSuccessorRef(spaceRef: string, legacyMemberPath: string, legacyMemberIdentity: string) {
  if (!text(spaceRef) || !text(legacyMemberPath) || !text(legacyMemberIdentity)) throw new Error('migration identity is required');
  return `composed-space-successor:${hash([text(spaceRef), text(legacyMemberPath), text(legacyMemberIdentity)])}`;
}

async function admitted(input: unknown, actionRef: string, context: BitfieldRuntimeContext | undefined, sender: Sender): Promise<{ payload: JsonRecord; actor: JsonRecord; decision: JsonRecord }> {
  const wrapped = record(input); const payload = record(wrapped?.payload); const actor = record(wrapped?.ambient_actor); const decision = record(wrapped?.access_decision); const revisions = record(decision?.revisions);
  if (!payload || !actor || !decision || !revisions || decision.decision !== 'allow' || text(actor.actor_ref) !== text(decision.actor_ref) || text(actor.session_ref) !== text(decision.session_ref) || text(actor.session_revision) !== text(revisions.session_revision)) throw new Error('server admission is required and must be current');
  const subjectRef = text(payload.scope_ref) || text(decision.subject_ref);
  const verified = record(await sender({ target: 'access-rule.verify-decision', payload: { decision_proof: decision.decision_proof, actor_ref: actor.actor_ref, session_ref: actor.session_ref, subject_ref: subjectRef, action_ref: actionRef, revisions } }));
  const durable = record(verified?.decision);
  if (verified?.verified !== true || !durable || text(durable.actor_ref) !== text(actor.actor_ref) || text(durable.subject_ref) !== subjectRef) throw new Error('server admission is not durable or does not authorize this owner action');
  return { payload, actor: { actor_ref: durable.actor_ref, session_ref: durable.session_ref, session_revision: record(durable.revisions)?.session_revision }, decision: durable };
}
function ownerRequest(payload: JsonRecord, actor: JsonRecord, decision: JsonRecord) { return { payload, ambient_actor: actor, access_decision: decision }; }
function replyBytes(reply: unknown): Uint8Array { if (reply instanceof Uint8Array) return reply; if (reply instanceof ArrayBuffer) return new Uint8Array(reply); if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength); const payload = record(reply)?.payload; if (payload === undefined) throw new Error('engine reply did not include bytes'); return replyBytes(payload); }
async function current(partition: string, address: string, sender: Sender): Promise<EngineReadCurrentReply> { return decodeEngineReadCurrentReply(replyBytes(await sender(buildEngineReadCurrentRequestFromLabels(partition, address)))); }
function decodeStored(currentValue: EngineReadCurrentReply): JsonRecord | null { if (!currentValue.found || currentValue.payload === null) return null; const parsed = record(JSON.parse(decoder.decode(currentValue.payload))); if (!parsed) throw new Error('legacy owner record must be an object'); return parsed; }
function basis(currentValue: EngineReadCurrentReply) { if (!currentValue.found) return null; if (!currentValue.payloadHash) throw new Error('engine current value lacks an atomic payload basis'); return currentValue.payloadHash; }
function legacyFrom(stored: JsonRecord | null): LegacyAggregate | null { if (!stored || stored.kind !== 'composed-space.legacy-aggregate/v1' || !text(stored.space_ref) || !text(stored.scope_ref) || !Number.isSafeInteger(stored.revision) || Number(stored.revision) < 0 || !record(stored.aggregate)) return null; return { space_ref: text(stored.space_ref), scope_ref: text(stored.scope_ref), revision: Number(stored.revision), aggregate: clone(record(stored.aggregate)!) }; }

function valuesAt(aggregate: JsonRecord, names: readonly string[]) { const roots = [{ path: 'legacy', value: aggregate }, { path: 'legacy.config', value: record(aggregate.config) }, { path: 'legacy.aggregate', value: record(aggregate.aggregate) }]; return roots.flatMap(({ path, value }) => value ? names.flatMap((name) => Array.isArray(value[name]) ? (value[name] as unknown[]).map((entry, index) => ({ path: `${path}.${name}[${index}]`, entry })) : []) : []); }
function scalarIdentity(value: unknown, fallback: string) { const row = record(value); return text(row?.id) || text(row?.ref) || text(row?.item_ref) || text(row?.relation_ref) || text(row?.participation_ref) || text(row?.actor_ref) || text(row?.actor) || (typeof value === 'string' && text(value)) || fallback; }
function fieldsOf(value: unknown, omit: readonly string[]) { const row = record(value); if (!row) return { value }; if (record(row.fields)) return clone(record(row.fields)!); if (record(row.participation)) return clone(record(row.participation)!); return Object.fromEntries(Object.entries(row).filter(([key]) => !omit.includes(key))); }
function isItemLike(value: unknown) { const row = record(value); return Boolean(row && (text(row.item_ref) || text(row.target_ref) || Object.prototype.hasOwnProperty.call(row, 'fields') || Object.prototype.hasOwnProperty.call(row, 'content'))); }
function successorPlan(spaceRef: string, legacy: LegacyAggregate): SuccessorPlan {
  const migration_basis = `composed-space-migration:${hash([spaceRef, legacy.revision, legacy.scope_ref])}`;
  const items = [...valuesAt(legacy.aggregate, ['items', 'item_rows', 'records']), ...valuesAt(legacy.aggregate, ['members']).filter(({ entry }) => isItemLike(entry))].map(({ path, entry }) => { const row = record(entry); const identity = scalarIdentity(entry, path); return { item_ref: text(row?.item_ref) || `legacy-item:${deterministicSuccessorRef(spaceRef, path, identity)}`, target_ref: spaceRef, expected_revision: 0, idempotency_ref: deterministicSuccessorRef(spaceRef, path, identity), requested_at: text(row?.created_at), fields: fieldsOf(entry, ['id', 'ref', 'item_ref', 'target_ref', 'created_at', 'revision']) }; });
  const participants = [...valuesAt(legacy.aggregate, ['participants', 'people']), ...valuesAt(legacy.aggregate, ['members']).filter(({ entry }) => !isItemLike(entry))].map(({ path, entry }) => { const row = record(entry); const actor_ref = text(row?.actor_ref) || text(row?.actor) || (typeof entry === 'string' ? text(entry) : ''); if (!actor_ref) throw new Error(`legacy participant has no actor identity at ${path}`); const identity = scalarIdentity(entry, path); return { subject_ref: legacy.scope_ref, participation_ref: text(row?.participation_ref) || `legacy-participant:${deterministicSuccessorRef(spaceRef, path, identity)}`, actor_ref, expected_revision: 0, idempotency_ref: deterministicSuccessorRef(spaceRef, path, identity), requested_at: text(row?.created_at), migration_basis, participation: fieldsOf(entry, ['id', 'ref', 'actor_ref', 'actor', 'participation_ref', 'created_at', 'revision']) }; });
  const relations = valuesAt(legacy.aggregate, ['relations', 'media_relations', 'evidence_relations']).map(({ path, entry }) => { const row = record(entry); const target_ref = text(row?.target_ref) || text(row?.item_ref); if (!target_ref) throw new Error(`legacy relation has no item target at ${path}`); const identity = scalarIdentity(entry, path); return { relation_ref: text(row?.relation_ref) || `legacy-relation:${deterministicSuccessorRef(spaceRef, path, identity)}`, target_ref, expected_revision: 0, idempotency_ref: deterministicSuccessorRef(spaceRef, path, identity), fields: fieldsOf(entry, ['id', 'ref', 'relation_ref', 'target_ref', 'item_ref', 'revision']) }; });
  const successor_refs = [...items, ...participants, ...relations].map((entry) => text(entry.idempotency_ref)).sort(); if (new Set(successor_refs).size !== successor_refs.length) throw new Error('legacy aggregate contains ambiguous successor identities');
  return { items, participants, relations, successor_refs, migration_basis };
}
function accepted(reply: unknown, label: string) { const value = record(reply); if (!value || value.status !== 'accepted' || value.conflict === true) throw new Error(`${label} did not accept the owner mutation`); return value; }
function expectedParity(plan: SuccessorPlan, itemRows: unknown, participantRows: unknown, relationRows: unknown) { const rows = (value: unknown) => Array.isArray(value) ? value.filter(record) as JsonRecord[] : []; const exact = (expected: JsonRecord, actual: JsonRecord, fieldsKey: string) => text(expected.idempotency_ref) === text(actual.idempotency_ref) && text(expected.target_ref ?? expected.subject_ref) === text(actual.target_ref ?? actual.subject_ref) && same(expected[fieldsKey], actual[fieldsKey]); const itemParity = plan.items.every((expected) => rows(itemRows).some((actual) => exact(expected, actual, 'fields'))); const participantParity = plan.participants.every((expected) => rows(participantRows).some((actual) => text(expected.idempotency_ref) === text(actual.idempotency_ref) && text(expected.actor_ref) === text(actual.actor_ref) && same(expected.participation, actual.participation))); const relationParity = plan.relations.every((expected) => rows(relationRows).some((actual) => exact(expected, actual, 'fields'))); return { parity: itemParity && participantParity && relationParity, item_rows: rows(itemRows), participant_rows: rows(participantRows), relation_rows: rows(relationRows) }; }

/**
 * The migration reads the retired owner record itself, derives fixed successor writes,
 * verifies every successor from its independent owner, then basis-retracts the legacy fact.
 */
export async function migrateEmbeddedSpaceMembersTarget(input: unknown, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  const { payload, actor, decision } = await admitted(input, 'composed-space.migrate-embedded-space-members', context, sender); const partition = readTrustedRuntimePartition(context);
  if (Object.prototype.hasOwnProperty.call(payload, 'successors') || Object.prototype.hasOwnProperty.call(payload, 'owner_target')) throw new Error('migration derives successors from owner truth; caller-provided targets are forbidden');
  const spaceRef = text(payload.space_ref); const idempotencyRef = text(payload.idempotency_ref); if (!spaceRef || !idempotencyRef || !Number.isSafeInteger(payload.expected_revision) || Number(payload.expected_revision) < 0) throw new Error('migration payload is invalid');
  const before = await current(partition, legacyAddress(spaceRef), sender); const stored = decodeStored(before); const retracted = stored?.kind === 'composed-space.legacy-retraction/v1';
  if (retracted) { const result = record(stored?.migration_result); if (text(stored?.migration_idempotency_ref) === idempotencyRef && result) return { ...clone(result), replay: true }; return { status: 'conflict', conflict: true, space_ref: spaceRef, expected_revision: Number(payload.expected_revision), current_revision: Number(stored?.revision) || 0, old_retracted: true }; }
  const legacy = legacyFrom(stored); if (!legacy || legacy.space_ref !== spaceRef || legacy.scope_ref !== text(decision.subject_ref)) throw new Error('legacy aggregate is unavailable or outside the admitted subject');
  if (Number(payload.expected_revision) !== legacy.revision) return { status: 'conflict', conflict: true, space_ref: spaceRef, expected_revision: Number(payload.expected_revision), current_revision: legacy.revision };
  const plan = successorPlan(spaceRef, legacy);
  if (plan.items.length) accepted(await sender({ target: fixedOwnerTargets.itemWrite, payload: ownerRequest({ scope_ref: legacy.scope_ref, mutations: plan.items }, actor, decision) }), 'item owner');
  if (plan.participants.length) accepted(await sender({ target: fixedOwnerTargets.participantWrite, payload: ownerRequest({ subject_ref: legacy.scope_ref, mutations: plan.participants, migration_basis: plan.migration_basis }, actor, decision) }), 'participant owner');
  if (plan.relations.length) accepted(await sender({ target: fixedOwnerTargets.relationWrite, payload: ownerRequest({ scope_ref: legacy.scope_ref, mutations: plan.relations }, actor, decision) }), 'relation owner');
  const itemRead = plan.items.length ? accepted(await sender({ target: fixedOwnerTargets.itemRead, payload: ownerRequest({ scope_ref: legacy.scope_ref, items: plan.items.map((entry) => ({ item_ref: entry.item_ref, target_ref: entry.target_ref })) }, actor, decision) }), 'item owner readback') : { rows: [] };
  const participantRead = plan.participants.length ? accepted(await sender({ target: fixedOwnerTargets.participantRead, payload: ownerRequest({ subject_ref: legacy.scope_ref, participations: plan.participants.map((entry) => ({ participation_ref: entry.participation_ref })) }, actor, decision) }), 'participant owner readback') : { rows: [] };
  const relationRead = plan.relations.length ? accepted(await sender({ target: fixedOwnerTargets.relationRead, payload: ownerRequest({ scope_ref: legacy.scope_ref, relations: plan.relations.map((entry) => ({ relation_ref: entry.relation_ref, target_ref: entry.target_ref })) }, actor, decision) }), 'relation owner readback') : { rows: [] };
  const parity = expectedParity(plan, itemRead.rows, participantRead.rows, relationRead.rows); if (!parity.parity) throw new Error('successor parity readback failed; legacy aggregate retained');
  const parity_basis = hash({ space_ref: spaceRef, migration_basis: plan.migration_basis, successor_refs: plan.successor_refs, successors: parity }); const result = { status: 'accepted', migrated: true, space_ref: spaceRef, successor_refs: plan.successor_refs, parity: true, parity_basis, old_retracted: true };
  const retraction = accepted(await sender({ target: 'composed-space.retract-legacy-embedded-space', payload: ownerRequest({ space_ref: spaceRef, scope_ref: legacy.scope_ref, expected_revision: legacy.revision, migration_idempotency_ref: idempotencyRef, migration_basis: plan.migration_basis, parity_basis, successor_refs: plan.successor_refs, migration_result: result }, actor, decision) }), 'legacy retraction');
  if (retraction.old_retracted !== true || text(retraction.parity_basis) !== parity_basis) throw new Error('legacy retraction readback failed');
  console.info(`[composed-space.migrate] space=${spaceRef} successors=${plan.successor_refs.length} parity=pass old_retracted=true`);
  return result;
}

/** Replaces the legacy aggregate with durable retraction provenance, guarded by the exact live aggregate basis. */
export async function retractLegacyEmbeddedSpaceTarget(input: unknown, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  const { payload, actor, decision } = await admitted(input, 'composed-space.retract-legacy-embedded-space', context, sender); const partition = readTrustedRuntimePartition(context); const spaceRef = text(payload.space_ref);
  if (!spaceRef || !Number.isSafeInteger(payload.expected_revision) || !text(payload.migration_idempotency_ref) || !text(payload.migration_basis) || !text(payload.parity_basis) || !Array.isArray(payload.successor_refs) || payload.successor_refs.some((ref) => !text(ref)) || !record(payload.migration_result)) throw new Error('legacy retraction basis is invalid');
  const before = await current(partition, legacyAddress(spaceRef), sender); const stored = decodeStored(before); if (stored?.kind === 'composed-space.legacy-retraction/v1') { if (text(stored.migration_idempotency_ref) === text(payload.migration_idempotency_ref)) return { status: 'accepted', replay: true, ...clone(stored) }; return { status: 'conflict', conflict: true, space_ref: spaceRef, current_revision: Number(stored.revision) || 0, old_retracted: true }; }
  const legacy = legacyFrom(stored); if (!legacy || legacy.space_ref !== spaceRef || legacy.scope_ref !== text(decision.subject_ref) || legacy.revision !== Number(payload.expected_revision)) return { status: 'conflict', conflict: true, space_ref: spaceRef, expected_revision: Number(payload.expected_revision), current_revision: legacy?.revision ?? 0 };
  const retraction = { kind: 'composed-space.legacy-retraction/v1', space_ref: spaceRef, scope_ref: legacy.scope_ref, revision: legacy.revision, migration_idempotency_ref: text(payload.migration_idempotency_ref), migration_basis: text(payload.migration_basis), parity_basis: text(payload.parity_basis), successor_refs: [...payload.successor_refs].map(text).sort(), migration_result: clone(record(payload.migration_result)!), retracted_by: text(actor.actor_ref), retracted_at: new Date(readTrustedRuntimeClockMs(context)).toISOString() };
  try { await sender(buildEngineWriteBatchRequestFromLabels([{ partitionLabel: partition, addressLabel: legacyAddress(spaceRef), pathLabels: ['current-item', 'legacy-retraction'], payloadBytes: encoder.encode(JSON.stringify(retraction)), expectedCurrent: { payloadHash: basis(before) } }])); } catch { /* exact re-read below classifies race/replay */ }
  const after = decodeStored(await current(partition, legacyAddress(spaceRef), sender));
  if (!after || after.kind !== 'composed-space.legacy-retraction/v1') throw new Error('legacy aggregate retraction readback failed');
  if (!same(after, retraction) && text(after.migration_idempotency_ref) !== text(payload.migration_idempotency_ref)) return { status: 'conflict', conflict: true, space_ref: spaceRef, current_revision: Number(after.revision) || 0, old_retracted: true };
  return { status: 'accepted', replay: !same(after, retraction), parity: true, old_retracted: true, space_ref: spaceRef, migration_idempotency_ref: text(payload.migration_idempotency_ref), migration_basis: text(payload.migration_basis), parity_basis: text(payload.parity_basis), successor_refs: [...payload.successor_refs].map(text).sort() };
}

export const composedSpaceLegacyOwnerAddresses = { legacy: legacyAddress };
