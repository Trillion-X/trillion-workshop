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

type JsonRecord = Record<string, unknown>;
type Sender = (request: unknown) => Promise<unknown>;
type GroupPageDescriptor = JsonRecord & {
  group_ref: string;
  scope_ref: string;
  join_policy_ref: string;
  descriptor: JsonRecord;
  revision: number;
  idempotency_ref: string;
  updated_at: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): JsonRecord | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : record(value)
    ? `{${Object.keys(record(value)!).sort().map((key) => `${JSON.stringify(key)}:${canonical(record(value)![key])}`).join(',')}}`
    : JSON.stringify(value);
const validRevision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const descriptorAddress = (groupRef: string) => `package::group-page::descriptor::${encodeURIComponent(groupRef)}`;
const receiptAddress = (groupRef: string, idempotencyRef: string) => `package::group-page::receipt::${encodeURIComponent(groupRef)}::${encodeURIComponent(idempotencyRef)}`;

export interface CreateGroupPageRequest {
  groupRef: string;
  scopeRef: string;
  joinPolicyRef: string;
  descriptor: JsonRecord;
  expectedRevision: number;
  idempotencyRef: string;
}

/** Browser callers express intent only. Hosted admission owns actor, time, and access proof. */
export function createGroupPage(request: CreateGroupPageRequest): Promise<unknown> {
  if (!text(request.groupRef) || !text(request.scopeRef) || !text(request.joinPolicyRef) || !record(request.descriptor) || !validRevision(request.expectedRevision) || !text(request.idempotencyRef)) {
    return Promise.reject(new Error('invalid group-page creation request'));
  }
  return sendRequestToBitfieldTarget({
    target: 'group-page.create-group-page',
    payload: {
      group_ref: request.groupRef,
      scope_ref: request.scopeRef,
      join_policy_ref: request.joinPolicyRef,
      descriptor: clone(request.descriptor),
      expected_revision: request.expectedRevision,
      idempotency_ref: request.idempotencyRef,
    },
  });
}

function replyBytes(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  const payload = record(reply)?.payload;
  if (payload === undefined) throw new Error('engine reply did not include bytes');
  return replyBytes(payload);
}

async function current(partition: string, address: string, sender: Sender): Promise<EngineReadCurrentReply> {
  return decodeEngineReadCurrentReply(replyBytes(await sender(buildEngineReadCurrentRequestFromLabels(partition, address))));
}

function stored(value: EngineReadCurrentReply): JsonRecord | null {
  if (!value.found || value.payload === null) return null;
  const decoded = record(JSON.parse(decoder.decode(value.payload)));
  if (!decoded) throw new Error('group-page owner record must be an object');
  return decoded;
}

function basis(value: EngineReadCurrentReply) {
  if (!value.found) return null;
  if (!value.payloadHash) throw new Error('engine current value lacks an atomic payload basis');
  return value.payloadHash;
}

async function admitted(input: unknown, sender: Sender) {
  const wrapped = record(input);
  const payload = record(wrapped?.payload);
  const actor = record(wrapped?.ambient_actor);
  const decision = record(wrapped?.access_decision);
  const revisions = record(decision?.revisions);
  if (!payload || !actor || !decision || !revisions || decision.decision !== 'allow'
    || text(actor.actor_ref) !== text(decision.actor_ref)
    || text(actor.session_ref) !== text(decision.session_ref)
    || text(actor.session_revision) !== text(revisions.session_revision)
    || text(payload.scope_ref) !== text(decision.subject_ref)) {
    throw new Error('server admission is required and must be current');
  }
  const verified = decodeJsonReply(await sender({
    target: 'access-rule.verify-decision',
    payload: {
      decision_proof: decision.decision_proof,
      actor_ref: actor.actor_ref,
      session_ref: actor.session_ref,
      subject_ref: payload.scope_ref,
      action_ref: 'group-page.create-group-page',
      revisions,
    },
  }));
  const durable = record(verified?.decision);
  if (verified?.verified !== true || !durable || text(durable.actor_ref) !== text(actor.actor_ref) || text(durable.subject_ref) !== text(payload.scope_ref)) {
    throw new Error('server admission is not durable or does not authorize this owner action');
  }
  return { payload, actor: durable };
}

function decodeJsonReply(reply: unknown): JsonRecord {
  if (reply instanceof Uint8Array || reply instanceof ArrayBuffer || ArrayBuffer.isView(reply)) {
    const value = record(JSON.parse(decoder.decode(replyBytes(reply))));
    if (!value) throw new Error('owner target reply must be an object');
    return value;
  }
  const outer = record(reply);
  if (!outer) throw new Error('owner target reply must be an object');
  const payload = outer.payload;
  if (payload instanceof Uint8Array || payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
    const value = record(JSON.parse(decoder.decode(replyBytes(payload))));
    if (!value) throw new Error('owner target reply must be an object');
    return value;
  }
  return outer;
}

async function emitAcceptedEvent(row: GroupPageDescriptor, actorRef: string, sender: Sender) {
  const eventRef = `owner-accepted:${row.group_ref}:${row.idempotency_ref}`;
  const signed = decodeJsonReply(await sender({
    target: 'signed-event-author.sign-event',
    payload: {
      payload: {
        event_id: eventRef,
        namespace: 'owner-action',
        occurred_at: row.updated_at,
        idempotency_key: eventRef,
        supersedes: [],
        facts: [{
          fact_id: `${eventRef}:mutation`,
          subject: actorRef,
          relation: 'owner-action.accepted',
          object: 'group-page.create-group-page',
          attributes: {
            subject_ref: row.scope_ref,
            owner_ref: row.group_ref,
            owner_revision: row.revision,
            idempotency_ref: row.idempotency_ref,
          },
        }],
      },
    },
  }));
  const authority = decodeJsonReply(await sender({
    target: 'signed-event-authority.admit-event',
    payload: { body: { events: [signed] }, request_id: eventRef },
  }));
  const hashes = record(record(authority.evaluation)?.event_hashes);
  const eventHash = text(hashes?.[eventRef]);
  if (!eventHash) throw new Error('signed accepted event was not admitted');
  await sender({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: 'action:owner-action-event-log.record-owner-action-event',
      include_output: true,
      input: { event: signed, canonical_hash: eventHash },
    },
  });
  return { event_ref: eventRef, event_hash: eventHash };
}

/** Durable community-page owner: basis-check, readback, then one retry-safe accepted event. */
export async function createGroupPageTarget(input: unknown, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  const { payload, actor } = await admitted(input, sender);
  const partition = readTrustedRuntimePartition(context);
  const groupRef = text(payload.group_ref);
  const scopeRef = text(payload.scope_ref);
  const joinPolicyRef = text(payload.join_policy_ref);
  const descriptor = record(payload.descriptor);
  const idempotencyRef = text(payload.idempotency_ref);
  if (!groupRef || !scopeRef || !joinPolicyRef || !descriptor || !validRevision(payload.expected_revision) || !idempotencyRef) throw new Error('invalid group-page descriptor mutation');
  if ('owner_target' in descriptor || 'write_target' in descriptor || 'effect_target' in descriptor) throw new Error('group-page descriptor cannot select owner targets');

  const descriptorRef = descriptorAddress(groupRef);
  const receiptRef = receiptAddress(groupRef, idempotencyRef);
  const [beforeDescriptor, beforeReceipt] = await Promise.all([current(partition, descriptorRef, sender), current(partition, receiptRef, sender)]);
  const existing = stored(beforeDescriptor) as GroupPageDescriptor | null;
  const replay = stored(beforeReceipt);
  const fingerprint = canonical({ group_ref: groupRef, scope_ref: scopeRef, join_policy_ref: joinPolicyRef, descriptor, expected_revision: payload.expected_revision, idempotency_ref: idempotencyRef });
  if (replay) {
    if (replay.kind !== 'group-page.mutation-receipt/v1' || replay.fingerprint !== fingerprint || !existing) throw new Error('idempotency receipt does not match durable group-page truth');
    const event = await emitAcceptedEvent(existing, text(actor.actor_ref), sender);
    return { status: 'accepted', replay: true, group_ref: groupRef, revision: existing.revision, descriptor: clone(existing), ...event };
  }

  const currentRevision = Number(existing?.revision) || 0;
  if (Number(payload.expected_revision) !== currentRevision) return { status: 'conflict', conflict: true, group_ref: groupRef, expected_revision: Number(payload.expected_revision), current_revision: currentRevision, current: existing };
  if (existing && existing.scope_ref !== scopeRef) throw new Error('group-page scope is immutable');
  // The runtime's clock, not this module's: the engine replays this target against
  // the log, and created_at, updated_at and the receipt's accepted_at all derive
  // from this one value, which the replay branch then compares by fingerprint.
  const now = new Date(readTrustedRuntimeClockMs(context)).toISOString();
  const next: GroupPageDescriptor = {
    kind: 'group-page.descriptor/v1',
    group_ref: groupRef,
    scope_ref: scopeRef,
    join_policy_ref: joinPolicyRef,
    descriptor: clone(descriptor),
    revision: currentRevision + 1,
    idempotency_ref: idempotencyRef,
    created_by: existing?.created_by ?? text(actor.actor_ref),
    created_at: existing?.created_at ?? now,
    updated_by: text(actor.actor_ref),
    updated_at: now,
  };
  const receipt = { kind: 'group-page.mutation-receipt/v1', group_ref: groupRef, idempotency_ref: idempotencyRef, fingerprint, revision: next.revision, actor_ref: text(actor.actor_ref), accepted_at: now };
  try {
    await sender(buildEngineWriteBatchRequestFromLabels([
      { partitionLabel: partition, addressLabel: descriptorRef, pathLabels: ['current-item', 'published-record'], payloadBytes: encoder.encode(JSON.stringify(next)), expectedCurrent: { payloadHash: basis(beforeDescriptor) } },
      { partitionLabel: partition, addressLabel: receiptRef, pathLabels: ['current-item', 'mutation-receipt'], payloadBytes: encoder.encode(JSON.stringify(receipt)), expectedCurrent: { payloadHash: null } },
    ]));
  } catch {
    // The exact durable readback below distinguishes an idempotent race from a conflict.
  }
  const [afterDescriptor, afterReceipt] = await Promise.all([current(partition, descriptorRef, sender), current(partition, receiptRef, sender)]);
  const durable = stored(afterDescriptor) as GroupPageDescriptor | null;
  const durableReceipt = stored(afterReceipt);
  if (!durable || durableReceipt?.fingerprint !== fingerprint) {
    return { status: 'conflict', conflict: true, group_ref: groupRef, expected_revision: Number(payload.expected_revision), current_revision: Number(durable?.revision) || 0, current: durable };
  }
  const event = await emitAcceptedEvent(durable, text(actor.actor_ref), sender);
  console.info(`[group-page.create] group=${groupRef} revision=${durable.revision} result=accepted`);
  return { status: 'accepted', replay: canonical(durable) !== canonical(next), group_ref: groupRef, revision: durable.revision, descriptor: clone(durable), ...event };
}

export const groupPageOwnerAddresses = { descriptor: descriptorAddress, receipt: receiptAddress };
