import {
  readTrustedRuntimeClockMs,
  readTrustedRuntimePartition,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineReadCurrentRequestFromPartitionReference,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  type EngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';
import { evaluateAccessDecision } from '../src/evaluate';
import type { AccessDecision, RevisionVector } from '../src/records';
import { isObject, validateAccessDecision, validateAccessDecisionRequest } from '../src/validate-records';

type Sender = (request: unknown) => Promise<unknown>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : isObject(value)
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

export const accessDecisionOwnerAddress = (proof: string) =>
  `package::access-rule::decision::${encodeURIComponent(proof)}`;

function replyBytes(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  const payload = isObject(reply) ? reply.payload : undefined;
  if (payload === undefined) throw new Error('target reply did not include bytes');
  return replyBytes(payload);
}

function jsonReply(reply: unknown): unknown {
  if (isObject(reply) && !('payload' in reply)) return reply;
  try { return JSON.parse(decoder.decode(replyBytes(reply))); } catch { return reply; }
}

async function current(partition: string, proof: string, sender: Sender): Promise<EngineReadCurrentReply> {
  return decodeEngineReadCurrentReply(replyBytes(await sender(
    buildEngineReadCurrentRequestFromLabels(partition, accessDecisionOwnerAddress(proof)),
  )));
}

function currentDecision(value: EngineReadCurrentReply): AccessDecision | null {
  if (!value.found || value.payload === null) return null;
  const parsed = JSON.parse(decoder.decode(value.payload));
  const checked = validateAccessDecision(parsed);
  if (!checked.ok) throw new Error('access decision owner record is invalid');
  return checked.value;
}

/**
 * Executable access owner. Formula remains the evaluator; this target only
 * validates the complete request and durably records the exact decision that
 * downstream owners will verify by proof reference.
 */
export async function evaluateAccessDecisionTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
): Promise<AccessDecision> {
  const checked = validateAccessDecisionRequest(input);
  const decision = await evaluateAccessDecision(input, {
    async dispatch(request) {
      return jsonReply(await sender({ target: request.to_slot, payload: request.payload }));
    },
  }, readTrustedRuntimeClockMs(context));
  if (!checked.ok) return decision;

  const partition = readTrustedRuntimePartition(context);
  const before = await current(partition, decision.decision_proof, sender);
  const existing = currentDecision(before);
  if (existing) {
    if (canonical(existing) !== canonical(decision)) throw new Error('decision proof already names different owner truth');
    return existing;
  }

  try {
    await sender(buildEngineWriteBatchRequestFromLabels([{
      partitionLabel: partition,
      addressLabel: accessDecisionOwnerAddress(decision.decision_proof),
      pathLabels: ['current-item', 'access-decision'],
      payloadBytes: encoder.encode(JSON.stringify(decision)),
      expectedCurrent: { payloadHash: null },
    }]));
  } catch { /* exact owner readback below classifies a race */ }

  const stored = currentDecision(await current(partition, decision.decision_proof, sender));
  if (!stored || canonical(stored) !== canonical(decision)) {
    throw new Error('access decision owner readback failed');
  }
  return stored;
}

function revisionVector(value: unknown): RevisionVector | null {
  if (!isObject(value)) return null;
  const output = {
    membership_revision: text(value.membership_revision),
    policy_revision: text(value.policy_revision),
    resource_revision: text(value.resource_revision),
    session_revision: text(value.session_revision),
  };
  return Object.values(output).every(Boolean) ? output : null;
}

function expectedReplyMatches(actual: unknown, expected: unknown): boolean {
  if (!isObject(actual) || !isObject(expected)) return false;
  return Object.entries(expected).every(([key, value]) => canonical(actual[key]) === canonical(value));
}

async function revisionGuardsAreCurrent(decision: AccessDecision, sender: Sender): Promise<boolean> {
  const guards = decision.constraints.revision_guards;
  if (guards === undefined) return true;
  if (!Array.isArray(guards) || guards.length === 0 || guards.length > 16) return false;
  for (const value of guards) {
    if (!isObject(value) || !text(value.target) || !isObject(value.payload) || !isObject(value.expected_reply)) return false;
    try {
      const reply = jsonReply(await sender({ target: text(value.target), payload: value.payload }));
      if (!expectedReplyMatches(reply, value.expected_reply)) return false;
    } catch { return false; }
  }
  return true;
}

export type TransportPermissionBinding = {
  addresses: number[][];
  content_hashes: string[];
  permission_dependencies: Array<{ owner_address: number[]; revision: number[] }>;
};

/** Transport rights come only from the saved decision's constraints. A browser
 * may name that decision, but cannot supply or widen these resource lists. */
function transportPermissionBinding(decision: AccessDecision): TransportPermissionBinding | undefined {
  const binding = decision.constraints.transport_binding;
  const guards = decision.constraints.revision_guards;
  if (!isObject(binding) || !Array.isArray(guards) || guards.length === 0) return undefined;
  const bytes = (value: unknown): value is number[] => Array.isArray(value)
    && value.length > 0 && value.length <= 4096
    && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  if (!Array.isArray(binding.addresses) || binding.addresses.length > 128
    || !binding.addresses.every(bytes)
    || !Array.isArray(binding.content_hashes) || binding.content_hashes.length > 128
    || !binding.content_hashes.every(hash => typeof hash === 'string' && hash.length > 0 && hash.length <= 4096)
    || !Array.isArray(binding.permission_dependencies) || binding.permission_dependencies.length === 0
    || binding.permission_dependencies.length > 128) return undefined;
  const dependencies: TransportPermissionBinding['permission_dependencies'] = [];
  for (const dependency of binding.permission_dependencies) {
    if (!isObject(dependency) || !bytes(dependency.owner_address) || !bytes(dependency.revision)
      || !Number.isInteger(dependency.guard_index) || Number(dependency.guard_index) < 0
      || Number(dependency.guard_index) >= guards.length) return undefined;
    const guard = guards[Number(dependency.guard_index)];
    // The dependency must be attached to a real owner recheck, not a standalone
    // watched address whose changes could otherwise be mistaken for authority.
    if (!isObject(guard) || !text(guard.target) || !isObject(guard.payload)
      || !isObject(guard.expected_reply) || Object.keys(guard.expected_reply).length === 0) return undefined;
    if (guard.target !== 'access-rule.verify-permission-dependency'
      || canonical(guard.payload.owner_address) !== canonical(dependency.owner_address)
      || canonical(guard.payload.revision) !== canonical(dependency.revision)
      || guard.expected_reply.verified !== true) return undefined;
    dependencies.push({ owner_address: [...dependency.owner_address], revision: [...dependency.revision] });
  }
  return { addresses: binding.addresses.map(address => [...address]),
    content_hashes: [...binding.content_hashes] as string[], permission_dependencies: dependencies };
}

/**
 * Downstream owners call this target before touching state. A wrapper alone is
 * never authority: verification succeeds only when the access owner can read
 * the same allowed decision from durable engine truth.
 */
export async function verifyAccessDecisionTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
): Promise<{ verified: boolean; reason?: string; decision?: AccessDecision; transport_binding?: TransportPermissionBinding }> {
  if (!isObject(input)) return { verified: false, reason: 'invalid-verification-request' };
  const decisionProof = text(input.decision_proof);
  const actorRef = text(input.actor_ref);
  const sessionRef = text(input.session_ref);
  const subjectRef = text(input.subject_ref);
  // action_ref is OPTIONAL. A caller with one particular action in mind
  // (isAllowed, ai-action-guard) still supplies it and gets the tighter check.
  // A caller saving a NOTE listing several actions (the permission-lease save target, which no served row calls) supplies
  // none, so the verified decision returns ordering-independent: it used to
  // reject the whole request when the FIRST requested action was not in the
  // authorized set and accept the same set reordered, which reads as caller
  // ordering deciding what saves.
  const rawActionRef = typeof input.action_ref === 'string' ? input.action_ref : undefined;
  const actionRef = rawActionRef === undefined ? undefined : text(input.action_ref);
  const revisions = revisionVector(input.revisions);
  if (!decisionProof || !actorRef || !sessionRef || !subjectRef || !revisions
    || (rawActionRef !== undefined && !actionRef)) {
    return { verified: false, reason: 'invalid-verification-request' };
  }
  const decision = currentDecision(await current(readTrustedRuntimePartition(context), decisionProof, sender));
  if (!decision) return { verified: false, reason: 'decision-not-found' };
  const exact = decision.decision === 'allow'
    && decision.decision_proof === decisionProof
    && decision.actor_ref === actorRef
    && decision.session_ref === sessionRef
    && decision.subject_ref === subjectRef
    && (actionRef === undefined || decision.authorized_action_refs.includes(actionRef))
    && Object.entries(revisions).every(([key, value]) => decision.revisions[key as keyof RevisionVector] === value);
  if (!exact || !await revisionGuardsAreCurrent(decision, sender)) return { verified: false, reason: 'stale-or-unauthorized-decision' };
  const transportBinding = transportPermissionBinding(decision);
  return { verified: true, decision, ...(transportBinding ? { transport_binding: transportBinding } : {}) };
}

/** Resolve an opaque browser proof under an already verified session. Both the
 * rights and their recheck targets are read from the durable decision owner. */
export async function verifyTransportPermissionTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
): Promise<{ authorized: boolean; transport_binding?: TransportPermissionBinding }> {
  try {
    if (!isObject(input) || !text(input.decision_proof) || !text(input.actor_ref)
      || !text(input.session_ref) || !text(input.session_revision)
      || Object.keys(input).some(key => !['decision_proof', 'actor_ref', 'session_ref', 'session_revision'].includes(key))) return { authorized: false };
    const decision = currentDecision(await current(readTrustedRuntimePartition(context), text(input.decision_proof), sender));
    if (!decision || decision.revisions.session_revision !== input.session_revision) return { authorized: false };
    const verified = await verifyAccessDecisionTarget({
      decision_proof: input.decision_proof, actor_ref: input.actor_ref, session_ref: input.session_ref,
      subject_ref: decision.subject_ref, revisions: decision.revisions,
    }, context, sender);
    return verified.verified && verified.transport_binding
      ? { authorized: true, transport_binding: verified.transport_binding }
      : { authorized: false };
  } catch { return { authorized: false }; }
}

/** A changed permission record invalidates the saved decision without returning
 * its private contents. The caller cannot select another tenant's partition. */
export async function verifyPermissionDependencyTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
): Promise<{ verified: boolean }> {
  try {
    const bytes = (value: unknown): value is number[] => Array.isArray(value)
      && value.length > 0 && value.length <= 4096
      && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
    if (!isObject(input) || !bytes(input.owner_address) || !bytes(input.revision)) return { verified: false };
    const revision = input.revision;
    const result = decodeEngineReadCurrentReply(replyBytes(await sender(
      buildEngineReadCurrentRequestFromPartitionReference(
        { partitionLabel: readTrustedRuntimePartition(context) },
        { addressMultihashHex: input.owner_address.map(byte => byte.toString(16).padStart(2, '0')).join('') },
        { metadataOnly: true },
      ),
    )));
    return { verified: result.found && result.payloadHash !== undefined
      && result.payloadHash.length === revision.length
      && result.payloadHash.every((byte, index) => byte === revision[index]) };
  } catch { return { verified: false }; }
}
