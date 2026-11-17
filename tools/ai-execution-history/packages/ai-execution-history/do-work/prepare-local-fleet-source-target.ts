import { blake3 } from '@noble/hashes/blake3.js';
import {
  readTrustedRuntimePartition,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  makeHashCodeHexFromBytes,
  makeIdentityTextAddressFromLabel,
  type EngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';
import { LOCAL_DESKTOP_ACTOR } from '../../../../ui/show/action-affordance/local-actor-admission';

type Row = Record<string, unknown>;
type Sender = (request: { target: string; payload: unknown }) => Promise<unknown>;

const ACTION = 'ai-execution-history.prepare-local-fleet-source';
const PROVIDER_PROPERTY = 'prop:observed_content:source_descriptor';
const PUBLISHED_PATH = ['current-item', 'published-record', 'fleet-learning-index'] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const record = (value: unknown): Row | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Row : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() === value
  && value.length > 0 && value.length <= 512 ? value : null;
const ref = (value: unknown): string | null => {
  const candidate = text(value);
  return candidate && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(candidate) && !candidate.includes('::')
    ? candidate : null;
};
const hash = (bytes: Uint8Array): string => `1f:${[...blake3(bytes)]
  .map(value => value.toString(16).padStart(2, '0')).join('')}`;
const identity = (prefix: string, value: unknown): string => `${prefix}:${hash(encoder.encode(JSON.stringify(value)))}`;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = record(value);
  if (object) return `{${Object.keys(object).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

function bytes(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  const payload = record(reply)?.payload;
  if (payload !== undefined) return bytes(payload);
  throw new Error('The local source owner returned no readable answer.');
}

function decodedJson(reply: unknown): Row {
  const direct = record(reply);
  if (direct && !('payload' in direct)) return direct;
  const value = record(JSON.parse(decoder.decode(bytes(reply))));
  if (!value) throw new Error('The local source owner returned no readable answer.');
  return value;
}

async function current(
  partition: string,
  address: string,
  sender: Sender,
  addressMode: 'identity-text' | 'label-hash' = 'label-hash',
): Promise<EngineReadCurrentReply> {
  return decodeEngineReadCurrentReply(bytes(await sender(
    buildEngineReadCurrentRequestFromLabels(partition, address, { addressMode }),
  )));
}

function providerAddress(sourceRef: string): string {
  return `attribute_fact|${sourceRef}|${PROVIDER_PROPERTY}|type:observed_content`;
}

function providerSource(currentValue: EngineReadCurrentReply, sourceRef: string): { revision: string; basis: Uint8Array } {
  if (!currentValue.found || !currentValue.payload || !currentValue.payloadHash) {
    throw new Error('That local session source is not installed with a current revision.');
  }
  const row = record(JSON.parse(decoder.decode(currentValue.payload)));
  if (!row || row.table !== 'attribute_fact' || row.property_id !== PROVIDER_PROPERTY
    || row.type_id !== 'type:observed_content' || row.subject_id !== sourceRef
    || typeof row.value_json !== 'string') throw new Error('That local session source is invalid.');
  const descriptor = record(JSON.parse(row.value_json));
  if (!descriptor || descriptor.source_ref !== sourceRef
    || !text(descriptor.observer_capability_ref) || !text(descriptor.decoder_capability_ref)) {
    throw new Error('That local session source is invalid.');
  }
  const { provider_revision: declaredRevision, ...semanticDescriptor } = descriptor;
  const revision = `provider-record:${makeHashCodeHexFromBytes(encoder.encode(canonical([
    row.table, row.property_id, sourceRef, row.type_id, semanticDescriptor,
  ])))}`;
  if (!text(declaredRevision) || declaredRevision !== revision) {
    throw new Error('That local session source revision is invalid.');
  }
  return { revision,
    basis: currentValue.payloadHash };
}

async function verifiedLocalActor(input: Row, sender: Sender): Promise<{ actorRef: string; sourceRef: string }> {
  if (Object.keys(input).some(key => !['payload', 'ambient_actor', 'access_decision'].includes(key))) {
    throw new Error('The local source request has unexpected permission fields.');
  }
  const payload = record(input.payload); const actor = record(input.ambient_actor); const decision = record(input.access_decision);
  const sourceRef = ref(payload?.source_ref); const revisions = record(decision?.revisions);
  if (!payload || Object.keys(payload).some(key => key !== 'source_ref') || !sourceRef || !actor || !decision || !revisions
    || actor.actor_ref !== LOCAL_DESKTOP_ACTOR.actor_ref || actor.session_ref !== LOCAL_DESKTOP_ACTOR.session_ref
    || actor.session_revision !== LOCAL_DESKTOP_ACTOR.session_revision || decision.decision !== 'allow'
    || decision.actor_ref !== actor.actor_ref || decision.session_ref !== actor.session_ref
    || decision.subject_ref !== sourceRef || decision.action_ref !== ACTION
    || !Array.isArray(decision.authorized_action_refs) || decision.authorized_action_refs.length !== 1
    || decision.authorized_action_refs[0] !== ACTION || !text(decision.decision_proof)) {
    throw new Error('This local source request is not from the current local session.');
  }
  const verification = decodedJson(await sender({ target: 'access-rule.verify-decision', payload: {
    decision_proof: decision.decision_proof, actor_ref: actor.actor_ref, session_ref: actor.session_ref,
    subject_ref: sourceRef, action_ref: ACTION, revisions,
  } }));
  const durable = record(verification.decision);
  if (verification.verified !== true || !durable || durable.actor_ref !== actor.actor_ref
    || durable.session_ref !== actor.session_ref || durable.subject_ref !== sourceRef
    || durable.action_ref !== ACTION || !Array.isArray(durable.authorized_action_refs)
    || durable.authorized_action_refs.length !== 1 || durable.authorized_action_refs[0] !== ACTION) {
    throw new Error('This local source request is not from the current local session.');
  }
  return { actorRef: String(actor.actor_ref), sourceRef };
}

export async function prepareLocalFleetSourceTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
) {
  const request = record(input);
  if (!request) throw new Error('The local source request is invalid.');
  const { actorRef, sourceRef } = await verifiedLocalActor(request, sender);
  const partition = readTrustedRuntimePartition(context);
  const provider = await current(partition, providerAddress(sourceRef), sender, 'identity-text');
  const { revision, basis } = providerSource(provider, sourceRef);
  const installationRef = `installation:${partition}`;
  const boundContext = { installation_ref: installationRef, source_ref: sourceRef, user_ref: actorRef,
    provider_record_ref: providerAddress(sourceRef), provider_revision: revision };
  const permissionLeaseRef = identity('permission:fleet-analysis', boundContext);
  const descriptor = {
    kind: 'fleet-learning-source-descriptor', installation_ref: installationRef, source_ref: sourceRef,
    user_ref: actorRef, permission_lease_ref: permissionLeaseRef,
    provider_record_ref: providerAddress(sourceRef), provider_revision: revision,
  };
  const address = identity('package::ai-execution-history::fleet-learning-source', boundContext);
  const before = await current(partition, address, sender);
  if (before.found) {
    if (!before.payload || JSON.stringify(JSON.parse(decoder.decode(before.payload))) !== JSON.stringify(descriptor)) {
      throw new Error('This local source identity conflicts with an existing source.');
    }
    return { accepted: true, replay: true, descriptor_ref: address, descriptor };
  }
  await sender(buildEngineWriteBatchRequestFromLabels([{
    partitionLabel: partition, addressLabel: address, pathLabels: [...PUBLISHED_PATH],
    payloadBytes: encoder.encode(JSON.stringify(descriptor)), expectedCurrent: { payloadHash: null },
  }], [{ partitionLabel: partition, addressMultihashHex: makeIdentityTextAddressFromLabel(providerAddress(sourceRef)),
    expectedCurrent: { payloadHash: basis } }]) as { target: string; payload: unknown });
  const after = await current(partition, address, sender);
  if (!after.found || !after.payload
    || JSON.stringify(JSON.parse(decoder.decode(after.payload))) !== JSON.stringify(descriptor)) {
    throw new Error('The local source identity could not be confirmed.');
  }
  return { accepted: true, replay: false, descriptor_ref: address, descriptor };
}
