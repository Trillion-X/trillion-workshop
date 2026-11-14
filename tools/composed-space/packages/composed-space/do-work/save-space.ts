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

export type SaveSpaceRequest = { spaceRef?: string; scopeRef: string; kindRef: string; layoutRef?: string; fieldDescriptorRefs?: string[]; actionDescriptorRefs?: string[]; title: string; subtitle?: string; icon?: string; expectedRevision: number; idempotencyRef: string };
type JsonRecord = Record<string, unknown>;
type Sender = (request: unknown) => Promise<unknown>;
type OwnerDescriptor = JsonRecord & { space_ref: string; scope_ref: string; revision: number; idempotency_ref: string };
const encoder = new TextEncoder(); const decoder = new TextDecoder();
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const object = (value: unknown): JsonRecord | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const validRevision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : object(value) ? `{${Object.keys(object(value)!).sort().map((key) => `${JSON.stringify(key)}:${canonical(object(value)![key])}`).join(',')}}` : JSON.stringify(value);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);

/** `mintSpaceRef` supplies the ref for a space that does not have one yet. It is a
 *  parameter rather than a generator this module reaches for, because this file also
 *  holds `saveSpaceTarget`, which the engine replays against the log: a generator
 *  anywhere in it makes the same log mint a different ref on every run. The caller
 *  is a browser surface, whose entropy is an INPUT the log records. */
export async function saveSpace(request: SaveSpaceRequest, mintSpaceRef: () => string) {
  if (!text(request.scopeRef) || !text(request.kindRef) || !text(request.title) || !validRevision(request.expectedRevision) || !text(request.idempotencyRef)) return null;
  return sendRequestToBitfieldTarget({ target: 'composed-space.save-space', payload: { space_ref: text(request.spaceRef) || `composed-space:${mintSpaceRef()}`, scope_ref: text(request.scopeRef), kind_ref: text(request.kindRef), layout_ref: text(request.layoutRef), field_descriptor_refs: request.fieldDescriptorRefs ?? [], action_descriptor_refs: request.actionDescriptorRefs ?? [], title: text(request.title), subtitle: text(request.subtitle), icon: text(request.icon), expected_revision: request.expectedRevision, idempotency_ref: text(request.idempotencyRef) } });
}

function replyBytes(reply: unknown): Uint8Array { if (reply instanceof Uint8Array) return reply; if (reply instanceof ArrayBuffer) return new Uint8Array(reply); if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength); const payload = object(reply)?.payload; if (payload instanceof Uint8Array) return payload; if (payload instanceof ArrayBuffer) return new Uint8Array(payload); if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength); throw new Error('engine reply did not include bytes'); }
async function current(partitionLabel: string, address: string, sender: Sender): Promise<EngineReadCurrentReply> { return decodeEngineReadCurrentReply(replyBytes(await sender(buildEngineReadCurrentRequestFromLabels(partitionLabel, address)))); }
function parse(currentValue: EngineReadCurrentReply): JsonRecord | null { if (!currentValue.found || currentValue.payload === null) return null; const value = object(JSON.parse(decoder.decode(currentValue.payload))); if (!value) throw new Error('owner record payload must be an object'); return value; }
function basis(currentValue: EngineReadCurrentReply) { if (!currentValue.found) return null; if (!currentValue.payloadHash) throw new Error('engine current value lacks an atomic payload basis'); return currentValue.payloadHash; }
function descriptorAddress(spaceRef: string) { return `package::composed-space::descriptor::${encodeURIComponent(spaceRef)}`; }
function receiptAddress(spaceRef: string, idempotencyRef: string) { return `package::composed-space::receipt::${encodeURIComponent(spaceRef)}::${encodeURIComponent(idempotencyRef)}`; }
async function admitted(input: unknown, sender: Sender) {
  const wrapped = object(input); const payload = object(wrapped?.payload); const actor = object(wrapped?.ambient_actor); const decision = object(wrapped?.access_decision); const revisions = object(decision?.revisions);
  if (!payload || !actor || !decision || !revisions || decision.decision !== 'allow' || text(actor.actor_ref) !== text(decision.actor_ref) || text(actor.session_ref) !== text(decision.session_ref) || text(actor.session_revision) !== text(revisions.session_revision) || text(payload.scope_ref) !== text(decision.subject_ref)) throw new Error('server admission is required and must be current');
  const verified = object(await sender({ target: 'access-rule.verify-decision', payload: { decision_proof: decision.decision_proof, actor_ref: actor.actor_ref, session_ref: actor.session_ref, subject_ref: payload.scope_ref, action_ref: 'composed-space.save-space', revisions } }));
  const durable = object(verified?.decision);
  if (verified?.verified !== true || !durable || text(durable.actor_ref) !== text(actor.actor_ref) || text(durable.subject_ref) !== text(payload.scope_ref)) throw new Error('server admission is not durable or does not authorize this owner action');
  return { payload, actor: { actor_ref: durable.actor_ref, session_ref: durable.session_ref, session_revision: object(durable.revisions)?.session_revision } };
}
/** `nowIso` is handed in, never read here: this runs inside a target the engine
 *  replays, and a clock read here puts a different `created_at` in the record the
 *  readback guard compares against. */
function descriptor(payload: JsonRecord, actor: JsonRecord, existing: OwnerDescriptor | null, nowIso: string): OwnerDescriptor { const now = nowIso; const refs = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((entry) => text(entry)).map(text))].sort() : []; return { kind: 'composed-space.descriptor/v2', space_ref: text(payload.space_ref), scope_ref: text(payload.scope_ref), kind_ref: text(payload.kind_ref), layout_ref: text(payload.layout_ref), field_descriptor_refs: refs(payload.field_descriptor_refs), action_descriptor_refs: refs(payload.action_descriptor_refs), title: text(payload.title), subtitle: text(payload.subtitle), icon: text(payload.icon), revision: (Number(existing?.revision) || 0) + 1, created_by: existing?.created_by ?? text(actor.actor_ref), created_at: existing?.created_at ?? now, updated_by: text(actor.actor_ref), updated_at: now, idempotency_ref: text(payload.idempotency_ref) }; }

/** Durable engine owner target: every descriptor/receipt write is basis-checked and read back from kernel truth. */
export async function saveSpaceTarget(input: unknown, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  const { payload, actor } = await admitted(input, sender); const partitionLabel = readTrustedRuntimePartition(context); const spaceRef = text(payload.space_ref); const idempotencyRef = text(payload.idempotency_ref);
  if (!spaceRef || !text(payload.kind_ref) || !text(payload.title) || !validRevision(payload.expected_revision) || !idempotencyRef) throw new Error('invalid composed-space descriptor mutation');
  const descriptorRef = descriptorAddress(spaceRef); const receiptRef = receiptAddress(spaceRef, idempotencyRef); const [beforeDescriptor, beforeReceipt] = await Promise.all([current(partitionLabel, descriptorRef, sender), current(partitionLabel, receiptRef, sender)]);
  const existing = parse(beforeDescriptor) as OwnerDescriptor | null; const replay = parse(beforeReceipt);
  const fingerprint = canonical({ space_ref: spaceRef, scope_ref: payload.scope_ref, kind_ref: payload.kind_ref, layout_ref: payload.layout_ref, field_descriptor_refs: payload.field_descriptor_refs ?? [], action_descriptor_refs: payload.action_descriptor_refs ?? [], title: payload.title, subtitle: payload.subtitle, icon: payload.icon, expected_revision: payload.expected_revision, idempotency_ref: idempotencyRef });
  if (replay) { if (replay.kind !== 'composed-space.mutation-receipt/v1' || replay.fingerprint !== fingerprint) throw new Error('idempotency receipt names a different descriptor mutation'); const durable = existing; if (!durable) throw new Error('durable descriptor receipt has no descriptor readback'); return { status: 'accepted', replay: true, space_ref: spaceRef, revision: durable.revision, idempotency_ref: idempotencyRef, descriptor: durable }; }
  const currentRevision = Number(existing?.revision) || 0;
  if (Number(payload.expected_revision) !== currentRevision) return { status: 'conflict', conflict: true, space_ref: spaceRef, expected_revision: Number(payload.expected_revision), current_revision: currentRevision, current: existing };
  if (existing && existing.scope_ref !== text(payload.scope_ref)) throw new Error('space scope is immutable');
  const next = descriptor(payload, actor, existing, new Date(readTrustedRuntimeClockMs(context)).toISOString()); const receipt = { kind: 'composed-space.mutation-receipt/v1', space_ref: spaceRef, idempotency_ref: idempotencyRef, fingerprint, revision: next.revision, actor_ref: text(actor.actor_ref), accepted_at: next.updated_at };
  try { await sender(buildEngineWriteBatchRequestFromLabels([{ partitionLabel, addressLabel: descriptorRef, pathLabels: ['current-item', 'published-record'], payloadBytes: encoder.encode(JSON.stringify(next)), expectedCurrent: { payloadHash: basis(beforeDescriptor) } }, { partitionLabel, addressLabel: receiptRef, pathLabels: ['current-item', 'mutation-receipt'], payloadBytes: encoder.encode(JSON.stringify(receipt)), expectedCurrent: { payloadHash: null } }])); } catch { const afterReceipt = parse(await current(partitionLabel, receiptRef, sender)); const afterDescriptor = parse(await current(partitionLabel, descriptorRef, sender)) as OwnerDescriptor | null; if (afterReceipt?.fingerprint === fingerprint && afterDescriptor) return { status: 'accepted', replay: true, space_ref: spaceRef, revision: afterDescriptor.revision, idempotency_ref: idempotencyRef, descriptor: afterDescriptor }; const afterRevision = Number(afterDescriptor?.revision) || 0; return { status: 'conflict', conflict: true, space_ref: spaceRef, expected_revision: Number(payload.expected_revision), current_revision: afterRevision, current: afterDescriptor }; }
  const [afterDescriptor, afterReceipt] = await Promise.all([current(partitionLabel, descriptorRef, sender), current(partitionLabel, receiptRef, sender)]); const durable = parse(afterDescriptor) as OwnerDescriptor | null;
  if (!durable || !same(durable, next) || parse(afterReceipt)?.fingerprint !== fingerprint) throw new Error('descriptor owner readback failed');
  console.info(`[composed-space.save] space=${spaceRef} revision=${next.revision} result=accepted`); return { status: 'accepted', replay: false, space_ref: spaceRef, revision: next.revision, idempotency_ref: idempotencyRef, descriptor: durable };
}

export const composedSpaceOwnerAddresses = { descriptor: descriptorAddress, receipt: receiptAddress };
