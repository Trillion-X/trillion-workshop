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
  type EngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';

export type RevisionVector = { membership_revision: string; policy_revision: string; resource_revision: string; session_revision: string };
export type CoupledDecisionProof = { decision: 'allow'; decision_proof: string; actor_ref: string; session_ref: string; subject_ref: string; action_ref: string; revisions: RevisionVector };
export type AmbientActor = { actor_ref: string; session_ref: string; session_revision: string };
export interface OwnerActionInput { eventRef: string; scopeRef: string; targetRef: string; requestedAt: string; expectedRevision?: number; fields?: Record<string, unknown>; ambientActor?: AmbientActor; decisionProof?: CoupledDecisionProof; }
export interface OwnerActionValidationError { code: string; path: string; message: string; }
export interface OwnerActionBuildResult { ok: boolean; request?: { target: 'item-record.record-space-items'; payload: { scope_ref: string; mutations: Array<Record<string, unknown>> } }; errors?: OwnerActionValidationError[]; }

type JsonRecord = Record<string, unknown>;
type Sender = (request: unknown) => Promise<unknown>;
type ItemRow = JsonRecord & { item_ref: string; scope_ref: string; target_ref: string; revision: number; idempotency_ref: string; fields: JsonRecord; removed: boolean };
type Mutation = { item_ref: string; target_ref: string; expected_revision: number; idempotency_ref: string; fields: JsonRecord; requested_at: string; created_at?: string; operation: 'upsert' | 'remove' };
type SpaceIndexEntry = { item_ref: string; target_ref: string };
type SpaceIndex = JsonRecord & { kind: 'item-record.space-index/v1'; scope_ref: string; revision: number; item_order: string[]; entries: Record<string, SpaceIndexEntry> };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : '';
const record = (value: unknown): JsonRecord | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
function inputRecord(value: unknown): JsonRecord | null {
  if (typeof value === 'string') return record(JSON.parse(value));
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return record(JSON.parse(decoder.decode(bytes)));
  }
  const outer = record(value);
  if (!outer) return null;
  const payload = outer.payload;
  if (payload instanceof Uint8Array || payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
    const bytes = payload instanceof Uint8Array ? payload : payload instanceof ArrayBuffer
      ? new Uint8Array(payload)
      : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    const decoded = record(JSON.parse(decoder.decode(bytes)));
    if (!decoded) return null;
    if (!('ambient_actor' in outer) && !('access_decision' in outer)
      && ('ambient_actor' in decoded || 'access_decision' in decoded || 'payload' in decoded)) return decoded;
    // Some target adapters decode the top-level request but preserve its
    // serialized payload bytes. Decode only that transport layer; the signed
    // server admission remains independently verified below.
    return { ...outer, payload: decoded };
  }
  return outer;
}
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : record(value) ? `{${Object.keys(record(value)!).sort().map((key) => `${JSON.stringify(key)}:${canonical(record(value)![key])}`).join(',')}}` : JSON.stringify(value);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const rowAddress = (scopeRef: string, itemRef: string, targetRef: string) => `package::item-record::space-row::${encodeURIComponent(scopeRef)}::${encodeURIComponent(targetRef)}::${encodeURIComponent(itemRef)}`;
const receiptAddress = (scopeRef: string, idempotencyRef: string) => `package::item-record::receipt::${encodeURIComponent(scopeRef)}::${encodeURIComponent(idempotencyRef)}`;
const indexAddress = (scopeRef: string) => `package::item-record::space-index::${encodeURIComponent(scopeRef)}`;
const indexKey = (itemRef: string, targetRef: string) => canonical([targetRef, itemRef]);

function admission(input: OwnerActionInput): OwnerActionValidationError | null {
  const actor = input.ambientActor; const decision = input.decisionProof;
  if (!actor || !decision) return { code: 'missing-admission', path: 'admission', message: 'A server admission is required.' };
  if (!text(actor.actor_ref) || !text(actor.session_ref) || !text(actor.session_revision) || decision.decision !== 'allow' || !text(decision.decision_proof)) return { code: 'invalid-admission', path: 'admission', message: 'The server admission is invalid.' };
  if (decision.actor_ref !== actor.actor_ref || decision.session_ref !== actor.session_ref || decision.revisions.session_revision !== actor.session_revision) return { code: 'stale-admission', path: 'admission', message: 'The access decision is stale.' };
  if (decision.subject_ref !== input.scopeRef) return { code: 'scope-mismatch', path: 'scopeRef', message: 'The access decision is for another subject.' };
  return null;
}

/** Builds a package-owner request. The browser never receives a workflow target. */
export function buildOwnerActionRequest(input: OwnerActionInput): OwnerActionBuildResult {
  const errors: OwnerActionValidationError[] = [];
  if (!text(input.eventRef)) errors.push({ code: 'missing-required-text', path: 'eventRef', message: 'eventRef is required' });
  if (!text(input.scopeRef)) errors.push({ code: 'missing-required-text', path: 'scopeRef', message: 'scopeRef is required' });
  if (!text(input.targetRef)) errors.push({ code: 'missing-required-text', path: 'targetRef', message: 'targetRef is required' });
  if (!text(input.requestedAt)) errors.push({ code: 'missing-required-text', path: 'requestedAt', message: 'requestedAt is required' });
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) errors.push({ code: 'invalid-revision', path: 'expectedRevision', message: 'expectedRevision must be a non-negative integer.' });
  const admitted = admission(input); if (admitted) errors.push(admitted);
  if (errors.length) return { ok: false, errors };
  return { ok: true, request: { target: 'item-record.record-space-items', payload: { scope_ref: input.scopeRef, mutations: [{ item_ref: input.eventRef, target_ref: input.targetRef, requested_at: input.requestedAt, expected_revision: input.expectedRevision ?? 0, idempotency_ref: input.eventRef, fields: input.fields ?? {} }] } } };
}

async function admittedTarget(input: unknown, actionRef: string, context: BitfieldRuntimeContext | undefined, sender: Sender): Promise<{ payload: JsonRecord; actor: JsonRecord; decision: JsonRecord }> {
  const wrapped = inputRecord(input); const payload = record(wrapped?.payload); const actor = record(wrapped?.ambient_actor); const decision = record(wrapped?.access_decision); const revisions = record(decision?.revisions);
  const subjectRef = text(payload?.subject_ref) || text(payload?.scope_ref);
  const admissionFailures = [
    !payload && 'payload', !actor && 'ambient-actor', !decision && 'access-decision', !revisions && 'decision-revisions',
    decision?.decision !== 'allow' && 'allow-decision',
    actor && decision && text(actor.actor_ref) !== text(decision.actor_ref) && 'actor-binding',
    actor && decision && text(actor.session_ref) !== text(decision.session_ref) && 'session-binding',
    actor && revisions && text(actor.session_revision) !== text(revisions.session_revision) && 'session-revision',
    !subjectRef && 'subject',
    Boolean(payload && text(payload.subject_ref) && text(payload.scope_ref) && text(payload.subject_ref) !== text(payload.scope_ref)) && 'dual-subject',
    decision && subjectRef !== text(decision.subject_ref) && 'subject-binding',
  ].filter((failure): failure is string => typeof failure === 'string');
  if (admissionFailures.length) throw new Error(`server admission is required and must be current (${admissionFailures.join(', ')})`);
  const verified = decodeOwnerTargetReply(await sender({ target: 'access-rule.verify-decision', payload: { decision_proof: decision.decision_proof, actor_ref: actor.actor_ref, session_ref: actor.session_ref, subject_ref: subjectRef, action_ref: actionRef, revisions } }));
  const durable = record(verified?.decision);
  if (verified?.verified !== true || !durable || text(durable.actor_ref) !== text(actor.actor_ref) || text(durable.subject_ref) !== subjectRef) throw new Error('server admission is not durable or does not authorize this owner action');
  return { payload, actor: { actor_ref: durable.actor_ref, session_ref: durable.session_ref, session_revision: record(durable.revisions)?.session_revision }, decision: durable };
}
function replyBytes(reply: unknown): Uint8Array { if (reply instanceof Uint8Array) return reply; if (reply instanceof ArrayBuffer) return new Uint8Array(reply); if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength); const payload = record(reply)?.payload; return payload === reply ? (() => { throw new Error('engine reply did not include bytes'); })() : replyBytes(payload); }
/** Owner-to-owner replies may be direct JSON or runtime-wrapped JSON bytes. */
export function decodeOwnerTargetReply(reply: unknown): JsonRecord {
  if (reply instanceof Uint8Array || reply instanceof ArrayBuffer || ArrayBuffer.isView(reply)) {
    const decoded = record(JSON.parse(decoder.decode(replyBytes(reply))));
    if (!decoded) throw new Error('target reply must be an object');
    return decoded;
  }
  const outer = record(reply);
  if (!outer) throw new Error('target reply must be an object');
  if (outer.payload instanceof Uint8Array || outer.payload instanceof ArrayBuffer || ArrayBuffer.isView(outer.payload)) {
    const decoded = record(JSON.parse(decoder.decode(replyBytes(outer.payload))));
    if (!decoded) throw new Error('target reply must be an object');
    return decoded;
  }
  return outer;
}
async function current(partition: string, address: string, sender: Sender): Promise<EngineReadCurrentReply> { return decodeEngineReadCurrentReply(replyBytes(await sender(buildEngineReadCurrentRequestFromLabels(partition, address)))); }
function decodeObject(currentValue: EngineReadCurrentReply): JsonRecord | null { if (!currentValue.found || currentValue.payload === null) return null; const parsed = record(JSON.parse(decoder.decode(currentValue.payload))); if (!parsed) throw new Error('item owner record must be an object'); return parsed; }
function decodeRow(currentValue: EngineReadCurrentReply): ItemRow | null { return decodeObject(currentValue) as ItemRow | null; }
function decodeIndex(currentValue: EngineReadCurrentReply, scopeRef: string): SpaceIndex | null {
  const parsed = decodeObject(currentValue);
  if (!parsed) return null;
  if (parsed.kind !== 'item-record.space-index/v1' || text(parsed.scope_ref) !== scopeRef || !Number.isSafeInteger(parsed.revision) || !Array.isArray(parsed.item_order) || !record(parsed.entries)) throw new Error('item owner scope index is invalid');
  return parsed as SpaceIndex;
}
function basis(currentValue: EngineReadCurrentReply) { if (!currentValue.found) return null; if (!currentValue.payloadHash) throw new Error('engine current value lacks an atomic payload basis'); return currentValue.payloadHash; }
function mutation(value: unknown): Mutation {
  const raw = record(value); const operation = text(raw?.operation) || 'upsert'; const fields = record(raw?.fields);
  if (!raw || !text(raw.item_ref) || !text(raw.target_ref) || !text(raw.idempotency_ref) || !Number.isSafeInteger(raw.expected_revision) || Number(raw.expected_revision) < 0 || !fields || (operation !== 'upsert' && operation !== 'remove')) throw new Error('invalid item mutation');
  const createdAt = raw.created_at === undefined ? '' : text(raw.created_at);
  if (raw.created_at !== undefined && !createdAt) throw new Error('invalid historical creation time');
  return { item_ref: text(raw.item_ref), target_ref: text(raw.target_ref), expected_revision: Number(raw.expected_revision), idempotency_ref: text(raw.idempotency_ref), fields: clone(fields), requested_at: text(raw.requested_at), ...(createdAt ? { created_at: createdAt } : {}), operation };
}

export function historicalCreationTime(value: Mutation, decision: JsonRecord, now: string): string | undefined {
  if (!value.created_at) return undefined;
  const migration = record(record(decision.constraints)?.item_record_migration);
  const parsed = new Date(value.created_at);
  if (migration?.historical_created_at !== true || !text(migration.source_basis)
    || value.expected_revision !== 0 || value.operation !== 'upsert'
    || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value.created_at
    || parsed.valueOf() > new Date(now).valueOf()) {
    throw new Error('historical creation time requires an admitted zero-revision migration constraint');
  }
  return value.created_at;
}
function uniqueMutations(values: Mutation[]) {
  const unique: Mutation[] = [];
  for (const value of values) {
    const sameReceipt = unique.find((entry) => entry.idempotency_ref === value.idempotency_ref);
    if (sameReceipt) { if (!same(sameReceipt, value)) throw new Error('one idempotency ref cannot name different item mutations'); continue; }
    if (unique.some((entry) => entry.item_ref === value.item_ref && entry.target_ref === value.target_ref)) throw new Error('one item row may be mutated once per owner batch');
    unique.push(value);
  }
  return unique;
}
function receipt(mutationValue: Mutation, row: ItemRow, actorRef: string) { return { kind: 'item-record.mutation-receipt/v1', scope_ref: row.scope_ref, idempotency_ref: mutationValue.idempotency_ref, fingerprint: canonical(mutationValue), item_ref: row.item_ref, target_ref: row.target_ref, revision: row.revision, removed: row.removed, actor_ref: actorRef, accepted_at: row.updated_at }; }
function conflict(mutationValue: Mutation, currentRow: ItemRow | null) { return { item_ref: mutationValue.item_ref, target_ref: mutationValue.target_ref, expected_revision: mutationValue.expected_revision, current_revision: currentRow?.revision ?? 0, current: currentRow ? clone(currentRow) : null }; }
async function readRows(partition: string, scopeRef: string, requests: Array<{ item_ref: string; target_ref: string }>, sender: Sender) {
  const currentRows = await Promise.all(requests.map((entry) => current(partition, rowAddress(scopeRef, entry.item_ref, entry.target_ref), sender)));
  return currentRows.map(decodeRow).filter((row): row is ItemRow => Boolean(row && !row.removed)).sort((left, right) => `${left.target_ref}\u0000${left.item_ref}`.localeCompare(`${right.target_ref}\u0000${right.item_ref}`)).map(clone);
}
async function readIndexedRows(partition: string, scopeRef: string, sender: Sender) {
  const currentIndex = await current(partition, indexAddress(scopeRef), sender);
  const index = decodeIndex(currentIndex, scopeRef);
  if (!index) return [];
  const requested = index.item_order.map((key) => index.entries[key]).filter((entry): entry is SpaceIndexEntry => Boolean(entry && text(entry.item_ref) && text(entry.target_ref)));
  return requested.length ? readRows(partition, scopeRef, requested, sender) : [];
}

export function nextSpaceIndexMembers(existingIndex: Pick<SpaceIndex, 'entries' | 'item_order'> | null, mutations: Array<Pick<Mutation, 'item_ref' | 'target_ref' | 'operation'>>) {
  const entries = existingIndex ? clone(existingIndex.entries) : {};
  const item_order = existingIndex ? [...existingIndex.item_order] : [];
  for (const mutationValue of mutations) {
    const key = indexKey(mutationValue.item_ref, mutationValue.target_ref);
    if (mutationValue.operation === 'remove') {
      delete entries[key];
      const position = item_order.indexOf(key);
      if (position >= 0) item_order.splice(position, 1);
    } else {
      entries[key] = { item_ref: mutationValue.item_ref, target_ref: mutationValue.target_ref };
      if (!item_order.includes(key)) item_order.push(key);
    }
  }
  return { entries, item_order };
}

/** Durable owner target. Rows and idempotency receipts are engine facts guarded by their exact current bases. */
export async function recordSpaceItemsTarget(input: unknown, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  const { payload, actor, decision } = await admittedTarget(input, 'item-record.record-space-items', context, sender); const partition = readTrustedRuntimePartition(context);
  if (!Array.isArray(payload.mutations) || payload.mutations.length === 0) throw new Error('item mutations are required');
  const scopeRef = text(payload.scope_ref); const mutations = uniqueMutations(payload.mutations.map(mutation));
  let beforeIndex = await current(partition, indexAddress(scopeRef), sender); let existingIndex = decodeIndex(beforeIndex, scopeRef);
  const beforeRows = await Promise.all(mutations.map((entry) => current(partition, rowAddress(scopeRef, entry.item_ref, entry.target_ref), sender)));
  const beforeReceipts = await Promise.all(mutations.map((entry) => current(partition, receiptAddress(scopeRef, entry.idempotency_ref), sender)));
  const conflicts: JsonRecord[] = [];
  const pending: Array<{ mutation: Mutation; beforeRow: EngineReadCurrentReply; row: ItemRow; receipt: JsonRecord }> = [];
  const replayed = new Set(beforeReceipts.map((entry, index) => entry.found ? mutations[index].idempotency_ref : null).filter((entry): entry is string => Boolean(entry)));
  for (let index = 0; index < mutations.length; index += 1) {
    const mutationValue = mutations[index]; const row = decodeRow(beforeRows[index]); const storedReceipt = decodeRow(beforeReceipts[index]); const fingerprint = canonical(mutationValue);
    if (storedReceipt) { if (storedReceipt.kind !== 'item-record.mutation-receipt/v1' || storedReceipt.fingerprint !== fingerprint) throw new Error('idempotency receipt names a different item mutation'); continue; }
    if (mutationValue.expected_revision !== (row?.revision ?? 0)) { conflicts.push(conflict(mutationValue, row)); continue; }
    const now = new Date(readTrustedRuntimeClockMs(context)).toISOString(); const next: ItemRow = { kind: 'item-record.space-row/v1', item_ref: mutationValue.item_ref, scope_ref: scopeRef, target_ref: mutationValue.target_ref, revision: (row?.revision ?? 0) + 1, idempotency_ref: mutationValue.idempotency_ref, fields: clone(mutationValue.fields), created_by: row?.created_by ?? text(actor.actor_ref), created_at: row?.created_at ?? now, updated_by: text(actor.actor_ref), updated_at: now, removed: mutationValue.operation === 'remove' };
    if (mutationValue.created_at) next.created_at = historicalCreationTime(mutationValue, decision, now)!;
    pending.push({ mutation: mutationValue, beforeRow: beforeRows[index], row: next, receipt: receipt(mutationValue, next, text(actor.actor_ref)) });
  }
  if (conflicts.length) return { status: 'conflict', conflict: true, conflicts, rows: await readRows(partition, scopeRef, mutations, sender) };
  // Rows are addressed per item and never contend, but every mutation under a
  // scope also writes ONE shared index guarded on the whole record. Two
  // independent mutations read the same basis, so the engine rejected the
  // loser's ENTIRE batch and the readback reported a conflict for a row nothing
  // was contending. Index membership is a COMMUTATIVE SET, so a raced index is
  // re-read and the batch re-attempted.
  // SAFETY INVARIANT: only the INDEX basis is refreshed between attempts. Row
  // and receipt guards keep their original pre-attempt basis, so a genuine row
  // conflict keeps failing its own guard and still returns conflict. Refreshing
  // the row basis inside this loop would make it a lost-update bug.
  let replayConflicts: JsonRecord[] = [];
  let afterRows: EngineReadCurrentReply[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
  if (attempt > 0) { beforeIndex = await current(partition, indexAddress(scopeRef), sender); existingIndex = decodeIndex(beforeIndex, scopeRef); }
  const { entries: nextIndexEntries, item_order: nextItemOrder } = nextSpaceIndexMembers(existingIndex, mutations);
  const indexChanged = !existingIndex || !same(existingIndex.entries, nextIndexEntries) || !same(existingIndex.item_order, nextItemOrder);
  const nextIndex: SpaceIndex = { kind: 'item-record.space-index/v1', scope_ref: scopeRef, revision: (existingIndex?.revision ?? 0) + 1, item_order: nextItemOrder, entries: nextIndexEntries, updated_at: new Date(readTrustedRuntimeClockMs(context)).toISOString() };
  if (pending.length || indexChanged) {
    const entries = pending.flatMap((entry) => [
      { partitionLabel: partition, addressLabel: rowAddress(scopeRef, entry.row.item_ref, entry.row.target_ref), pathLabels: ['current-item', 'item-record-space-row'], payloadBytes: encoder.encode(JSON.stringify(entry.row)), expectedCurrent: { payloadHash: basis(entry.beforeRow) } },
      { partitionLabel: partition, addressLabel: receiptAddress(scopeRef, entry.mutation.idempotency_ref), pathLabels: ['current-item', 'mutation-receipt'], payloadBytes: encoder.encode(JSON.stringify(entry.receipt)), expectedCurrent: { payloadHash: null } },
    ]);
    if (indexChanged) entries.push({ partitionLabel: partition, addressLabel: indexAddress(scopeRef), pathLabels: ['current-item', 'item-record-space-index'], payloadBytes: encoder.encode(JSON.stringify(nextIndex)), expectedCurrent: { payloadHash: basis(beforeIndex) } });
    try { await sender(buildEngineWriteBatchRequestFromLabels(entries)); } catch { /* exact engine readback below turns a raced write into replay or conflict */ }
  }
  const afterReceipts = await Promise.all(mutations.map((entry) => current(partition, receiptAddress(scopeRef, entry.idempotency_ref), sender)));
  afterRows = await Promise.all(mutations.map((entry) => current(partition, rowAddress(scopeRef, entry.item_ref, entry.target_ref), sender)));
  const afterIndex = decodeIndex(await current(partition, indexAddress(scopeRef), sender), scopeRef);
  replayConflicts = [];
  for (let index = 0; index < mutations.length; index += 1) {
    const durableReceipt = decodeRow(afterReceipts[index]); const durableRow = decodeRow(afterRows[index]);
    const mutationValue = mutations[index]; const key = indexKey(mutationValue.item_ref, mutationValue.target_ref); const indexed = afterIndex?.entries[key];
    if (!durableReceipt || durableReceipt.kind !== 'item-record.mutation-receipt/v1' || durableReceipt.fingerprint !== canonical(mutationValue) || !durableRow || (mutationValue.operation === 'remove' ? Boolean(indexed) : indexed?.item_ref !== mutationValue.item_ref || indexed?.target_ref !== mutationValue.target_ref)) replayConflicts.push(conflict(mutationValue, durableRow));
  }
  if (!replayConflicts.length) break;
  }
  if (replayConflicts.length) return { status: 'conflict', conflict: true, conflicts: replayConflicts, rows: await readRows(partition, scopeRef, mutations, sender) };
  const receipts = afterRows.map((entry, index) => { const row = decodeRow(entry)!; return { status: 'accepted', item_ref: row.item_ref, target_ref: row.target_ref, revision: row.revision, idempotency_ref: mutations[index].idempotency_ref, replay: replayed.has(mutations[index].idempotency_ref), removed: row.removed, row: row.removed ? null : clone(row) }; });
  const rows = await readRows(partition, scopeRef, mutations, sender);
  if (receipts.some((entry) => !entry.removed && !rows.some((row) => row.idempotency_ref === entry.idempotency_ref))) throw new Error('item owner readback is incomplete');
  console.info(`[item-record.record] scope=${scopeRef} rows=${mutations.length} result=accepted`);
  return { status: 'accepted', conflict: false, receipts, rows };
}

/** Reads only explicitly requested independent rows; no package-owned process memory or broad aggregate scan exists. */
export async function readSpaceItemsTarget(input: unknown, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  const { payload } = await admittedTarget(input, 'item-record.read-space-items', context, sender); const partition = readTrustedRuntimePartition(context);
  if (payload.list_scope === true) return { status: 'accepted', rows: await readIndexedRows(partition, text(payload.scope_ref), sender) };
  if (!Array.isArray(payload.items) || payload.items.length === 0) throw new Error('explicit item owner row references or list_scope are required');
  const requested = payload.items.map((entry) => { const row = record(entry); if (!row || !text(row.item_ref) || !text(row.target_ref)) throw new Error('invalid item owner row reference'); return { item_ref: text(row.item_ref), target_ref: text(row.target_ref) }; });
  return { status: 'accepted', rows: await readRows(partition, text(payload.scope_ref), requested, sender) };
}

/** Public, session-admitted doorway for creating one item. Raw row identities and
 * owner-only target envelopes are derived here so browser entries never call the
 * durable item owner directly. */
export async function createItemRecordTarget(input: unknown, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  const { payload, actor, decision } = await admittedTarget(input, 'item-record.create-item-record', context, sender);
  const subjectRef = text(payload.subject_ref);
  const targetRef = text(payload.target_ref);
  const idempotencyRef = text(payload.idempotency_ref);
  const fields = record(payload.fields);
  const expectedRevision = payload.expected_revision;
  if (!subjectRef || !targetRef || !idempotencyRef || !fields || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new Error('invalid item creation request');
  if ('actor_ref' in payload || 'item_ref' in payload || 'owner_target' in payload || 'created_at' in payload) throw new Error('item creation derives actor, identity, owner target, and time');
  const itemRef = `item:${idempotencyRef}`;
  const ownerEnvelope = (ownerPayload: JsonRecord) => ({ payload: ownerPayload, ambient_actor: actor, access_decision: decision });
  const mutation = await recordSpaceItemsTarget(ownerEnvelope({ scope_ref: subjectRef, mutations: [{ item_ref: itemRef, target_ref: targetRef, expected_revision: Number(expectedRevision), idempotency_ref: idempotencyRef, fields: clone(fields) }] }), context, sender);
  if (mutation.status !== 'accepted' || mutation.conflict === true) throw new Error('item owner did not accept the new item');
  const readback = await readSpaceItemsTarget(ownerEnvelope({ scope_ref: subjectRef, items: [{ item_ref: itemRef, target_ref: targetRef }] }), context, sender);
  const row = readback.rows.find((entry) => text(entry.item_ref) === itemRef && text(entry.target_ref) === targetRef);
  if (!row) throw new Error('item owner readback is missing the new item');
  return { status: 'accepted', item_ref: itemRef, revision: row.revision, row: clone(row) };
}

/** Session-admitted read doorway used by generic item-list surfaces. */
export async function readItemRecordFeedTarget(input: unknown, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  const { payload, actor, decision } = await admittedTarget(input, 'item-record.read-feed-items', context, sender);
  const subjectRef = text(payload.subject_ref);
  if (!subjectRef) throw new Error('item feed subject is required');
  if ('actor_ref' in payload || 'items' in payload || 'list_scope' in payload || 'owner_target' in payload) throw new Error('item feed read derives actor, row selection, and owner target');
  const result = await readSpaceItemsTarget({
    payload: { scope_ref: subjectRef, list_scope: true },
    ambient_actor: actor,
    access_decision: decision,
  }, context, sender);
  return { status: 'accepted', subject_ref: subjectRef, rows: result.rows };
}

export const itemRecordOwnerAddresses = { row: rowAddress, receipt: receiptAddress, index: indexAddress };
