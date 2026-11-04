// PORTED FROM: bitfield-packages/packages/chat/do-work/execute-chat-work-requests.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';
import { selectDeclaredValue as selectDeclaredToolOutput } from '../../ui/read-data/declared-selector';
import { sameCapabilityRef, type CapabilityRef, type ChatWorkflowAction } from '../read-data/read-chat-work-actions';
import type { DiscoveredCapability } from './discover-capabilities';

export interface ChatWorkRequest { capabilityRef: CapabilityRef; input: unknown; correlationId?: string | null; proofRefs?: string[]; }
export interface RoundCapabilityAuthorization {
  turnId: string; round: number; callerAuthorityRef: string; authorityBindingRef: string; expiresAt: number; consumed: Set<string>;
  pending: Set<string>;
  capabilities: readonly CapabilityRef[];
  /** Exact human-selected request snapshots, when this is effect-specific consent. */
  requestBindings?: readonly string[];
}
export interface ChatWorkRequestResult {
  request: ChatWorkRequest; action: ChatWorkflowAction | null; accepted: boolean; error: string | null;
  evidenceRefs: string[]; workflowReply: unknown | null; dispatchedInput: unknown;
  receiptRef?: string; attemptRef?: string; status?: 'completed' | 'failed' | 'unknown_outcome' | 'cancelled_before_dispatch';
}
export type InFlightCapabilityDispatch = {
  /** Opaque caller-generated identity; never an action id or model-controlled value. */
  attemptId: string; turnId: string; request: ChatWorkRequest; action: ChatWorkflowAction;
  state: 'pre-dispatch' | 'dispatched' | 'settled';
};
const key = (ref: CapabilityRef) => `${ref.canonicalAddress}\u0000${ref.canonicalRevision}\u0000${ref.payloadHash}`;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function readRef(v: unknown): CapabilityRef | null {
  if (!record(v) || typeof v.canonicalAddress !== 'string' || typeof v.canonicalRevision !== 'string' || typeof v.payloadHash !== 'string') return null;
  return v.canonicalAddress && v.canonicalRevision && v.payloadHash ? v as CapabilityRef : null;
}
function decode(v: unknown): ChatWorkRequest | null {
  if (!record(v)) return null; const capabilityRef = readRef(v.capabilityRef);
  if (!capabilityRef) return null;
  return { capabilityRef, input: v.input, correlationId: typeof v.correlationId === 'string' ? v.correlationId : null,
    proofRefs: Array.isArray(v.proofRefs) ? v.proofRefs.filter((x): x is string => typeof x === 'string') : [] };
}
export function parseChatWorkRequests(text: string): ChatWorkRequest[] {
  const requests: ChatWorkRequest[] = [];
  for (const match of text.matchAll(/```bitfield-work-request\s*([\s\S]*?)```/g)) {
    try { const value = decode(JSON.parse(match[1]?.trim() ?? '')); if (value) requests.push(value); } catch { /* hostile model text is inert */ }
  }
  return requests;
}
/** One exact triple is usable at most once in one unexpired turn/round. */
export function authorizeRoundCapability(input: { turnId: string; round: number; callerAuthorityRef: string; authorityBindingRef?: string; ttlMs: number; now: number; capabilities: readonly CapabilityRef[]; requests?: readonly ChatWorkRequest[] }): RoundCapabilityAuthorization {
  if (!input.callerAuthorityRef) throw new Error('trusted caller authority is required');
  return { turnId: input.turnId, round: input.round, callerAuthorityRef: input.callerAuthorityRef, authorityBindingRef: input.authorityBindingRef ?? input.callerAuthorityRef, expiresAt: input.now + input.ttlMs, consumed: new Set(), pending: new Set(), capabilities: input.capabilities,
    ...(input.requests ? { requestBindings: Object.freeze(input.requests.map((request) => JSON.stringify(decode(request)))) } : {}) };
}
/** Persist only exact discovery identities whose owner provenance grants this caller. */
export function authorizeDiscoveredRound(input: { turnId: string; round: number; callerAuthorityRef: string; authorityBindingRef: string; ttlMs: number; now: number; discovered: readonly DiscoveredCapability[] }): RoundCapabilityAuthorization {
  const capabilities = input.discovered
    .filter((item) => item.authority_provenance_ref === input.authorityBindingRef)
    .map((item) => ({ canonicalAddress: item.canonical_address, canonicalRevision: item.canonical_revision, payloadHash: item.payload_hash }));
  return authorizeRoundCapability({ ...input, capabilities });
}
export function expireRoundAuthorization(authorization: RoundCapabilityAuthorization): void { authorization.expiresAt = 0; }
function deny(authorization: RoundCapabilityAuthorization | undefined, request: ChatWorkRequest, context: { turnId: string; round: number; callerAuthorityRef: string; now: number }): string | null {
  if (!authorization) return 'no round authorization';
  if (authorization.turnId !== context.turnId || authorization.round !== context.round || authorization.callerAuthorityRef !== context.callerAuthorityRef) return 'cross-turn, cross-round, or caller-authority authorization';
  if (context.now >= authorization.expiresAt) return 'round authorization expired';
  const id = key(request.capabilityRef);
  if (authorization.consumed.has(id)) return 'round authorization already consumed';
  if (authorization.pending.has(id)) return 'round authorization invocation already pending';
  if (!authorization.capabilities.some((ref) => sameCapabilityRef(ref, request.capabilityRef))) return 'capability was not discovered for this round';
  if (authorization.requestBindings && !authorization.requestBindings.includes(JSON.stringify(decode(request)))) return 'request differs from the exact approved effect';
  return null;
}
function replyPayload(reply: unknown): unknown {
  if (record(reply) && ArrayBuffer.isView(reply.payload)) { try { return JSON.parse(new TextDecoder().decode(reply.payload as Uint8Array)); } catch { return reply; } }
  return reply;
}
/** A workflow finishing does not imply that its domain action succeeded. */
function ownerFailure(value: unknown): string | null {
  const payload = replyPayload(value);
  if (!record(payload)) return null;
  for (const result of [payload, payload.output]) {
    if (!record(result)) continue;
    if (result.accepted === false || result.ok === false || result.success === false
      || ['failed', 'error', 'denied', 'rejected', 'cancelled'].includes(String(result.status))) {
      return typeof result.error === 'string' ? result.error : `owner reported ${result.status ?? 'failure'}`;
    }
  }
  return null;
}
function opaqueAttemptRef(): string {
  // `crypto.randomUUID` is cryptographically random in every supported browser
  // and Node runtime.  The getRandomValues branch retains that property for
  // runtimes which intentionally omit UUID convenience API.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('cryptographic attempt identity is unavailable');
}
function correlationInput(schema: unknown, value: unknown, attemptRef: string): unknown {
  if (!record(schema) || !record(schema.properties) || !record(value)) return value;
  // Correlation is caller evidence only when the owner declared a compatible
  // input field. Never invent an undeclared schema field.
  const field = Object.prototype.hasOwnProperty.call(schema.properties, 'correlationId') ? 'correlationId'
    : Object.prototype.hasOwnProperty.call(schema.properties, 'correlation_id') ? 'correlation_id' : null;
  return field ? { ...value, [field]: attemptRef } : value;
}
/** Applies only an owner-validated selector. It never searches arbitrary output. */
export { selectDeclaredToolOutput };
function hydratedDefinitionId(reply: unknown, ref: CapabilityRef): string | null {
  const value = replyPayload(reply);
  if (!record(value)) return null;
  const row = record(value.output) ? value.output : value;
  if (row.status !== 'ok' || !Array.isArray(row.hydrated) || row.hydrated.length !== 1 || !record(row.hydrated[0])) return null;
  const hydrated = row.hydrated[0];
  return hydrated.address === ref.canonicalAddress
    && hydrated.payload_hash === ref.payloadHash
    && typeof hydrated.definition_id === 'string'
    && hydrated.definition_id.length > 0
    ? hydrated.definition_id
    : null;
}
/** JIT validates the exact current EEAF/Workflow triple; action IDs never authorize. */
export async function executeChatWorkRequests(input: {
  assistantText: string; workflowActions: readonly ChatWorkflowAction[]; authorization?: RoundCapabilityAuthorization;
  turnId?: string; round?: number; callerAuthorityRef?: string; now?: () => number;
  observe?: (event: Record<string, unknown>) => void;
  enrichInput?: (capabilityRef: CapabilityRef, value: unknown, index: number) => unknown;
  /** Trusted retry intent, supplied only by the human interaction owner. */
  explicitRetry?: { priorAttemptRef: string };
  /** Injected addressed read: ambiguous delivery checks this receipt before any retry. */
  readReceipt?: (address: string) => Promise<unknown | null>;
  attemptRef?: () => string;
  partitionKey?: string | null;
  signal?: AbortSignal;
  onLifecycle?: (dispatch: InFlightCapabilityDispatch) => void;
}): Promise<ChatWorkRequestResult[]> {
  const now = input.now ?? Date.now; const results: ChatWorkRequestResult[] = [];
  for (const [index, request] of parseChatWorkRequests(input.assistantText).entries()) {
    const enrichedInput = input.enrichInput ? input.enrichInput(request.capabilityRef, request.input, index) : request.input;
    const context = { turnId: input.turnId ?? '', round: input.round ?? -1, callerAuthorityRef: input.callerAuthorityRef ?? '', now: now() };
    const reason = deny(input.authorization, { ...request, input: enrichedInput }, context);
    const action = input.workflowActions.find((candidate) => candidate.active && sameCapabilityRef(candidate.capabilityRef, request.capabilityRef)) ?? null;
    if (reason || !action) {
      input.observe?.({ event: 'chat.action_denied', address: request.capabilityRef.canonicalAddress, reason_ref: reason ?? 'stale-or-missing-current-owner' });
      results.push({ request, action, accepted: false, error: reason ?? 'current action is stale, retracted, or tampered', evidenceRefs: [], workflowReply: null, dispatchedInput: enrichedInput }); continue;
    }
    const capabilityKey = key(request.capabilityRef);
    const attemptRef = (input.attemptRef ?? opaqueAttemptRef)();
    const receiptRef = `package::chat::workflow-execution-receipt::${attemptRef}`;
    const dispatchedInput = input.authorization?.requestBindings
      ? (enrichedInput === undefined ? undefined : JSON.parse(JSON.stringify(enrichedInput)))
      : correlationInput(action.inputSchema, enrichedInput, attemptRef);
    const lifecycle = (state: InFlightCapabilityDispatch['state']) => input.onLifecycle?.({ attemptId: attemptRef, turnId: context.turnId, request, action, state });
    lifecycle('pre-dispatch');
    if (input.signal?.aborted) {
      input.observe?.({ event: 'chat.action_denied', address: request.capabilityRef.canonicalAddress, reason_ref: 'aborted-before-dispatch' });
      results.push({ request, action, accepted: false, error: 'cancelled before dispatch', evidenceRefs: [], workflowReply: null, dispatchedInput, attemptRef, status: 'cancelled_before_dispatch' });
      continue;
    }
    // JavaScript runs synchronously until the first await, so this reservation
    // is atomic within the authorization object. Concurrent replays observe the
    // pending key and fail before issuing an owner hydration request.
    input.authorization!.pending.add(capabilityKey);
    let admitted = false;
    try {
      const hydration = await sendRequestToBitfieldTarget({ target: 'slot::workflow', payload: {
        operation: 'owner_slot_hydration_status', expected_records: [{ address: request.capabilityRef.canonicalAddress, expected_payload_hash: request.capabilityRef.payloadHash }],
      } }, input.signal);
      const definitionId = hydratedDefinitionId(hydration, request.capabilityRef);
      if (!definitionId) {
        input.authorization!.pending.delete(capabilityKey);
        input.observe?.({ event: 'chat.action_denied', address: request.capabilityRef.canonicalAddress, reason_ref: 'owner-slot-hydration-mismatch' });
        results.push({ request, action, accepted: false, error: 'owner-slot hydration did not prove the exact current capability', evidenceRefs: [action.recordId], workflowReply: null, dispatchedInput, attemptRef });
        continue;
      }
      const awaitBoundaryReason = input.signal?.aborted
        ? 'aborted-before-dispatch'
        : now() >= input.authorization!.expiresAt
          ? 'round-authorization-expired-during-owner-proof'
          : null;
      if (awaitBoundaryReason) {
        input.authorization!.pending.delete(capabilityKey);
        input.observe?.({ event: 'chat.action_denied', address: request.capabilityRef.canonicalAddress, reason_ref: awaitBoundaryReason });
        results.push({ request, action, accepted: false, error: awaitBoundaryReason, evidenceRefs: [action.recordId], workflowReply: null, dispatchedInput, attemptRef, status: 'cancelled_before_dispatch' });
        continue;
      }
      // Authorization is consumed only once the owner has proved the exact
      // current address/hash.  A stale hydration result is a denial, never an
      // admitted/consumed attempt.
      input.authorization!.pending.delete(capabilityKey);
      input.authorization!.consumed.add(capabilityKey);
      admitted = true;
      input.observe?.({ event: 'chat.action_admitted', address: request.capabilityRef.canonicalAddress, live_revision: request.capabilityRef.canonicalRevision, authority_ref: input.authorization!.callerAuthorityRef });
      lifecycle('dispatched');
      const workflowReply = replyPayload(await sendRequestToBitfieldTarget({ target: action.ownerTargetRef, payload: {
        // The owner slot, not the scoped display feed, supplies the executable
        // definition identity after proving the current address/hash.
        operation: 'execute_definition', definition_id: definitionId, include_steps: false, include_output: true, input: dispatchedInput,
        receipt: { address: receiptRef, path: ['chat', 'workflow-execution-receipts'], partition_key: input.partitionKey ?? undefined,
          evidence: { attempt_ref: attemptRef, turn_ref: context.turnId, round_ref: context.round, ordinal: index,
            capability_ref: request.capabilityRef, ...(input.explicitRetry?.priorAttemptRef ? { prior_attempt_ref: input.explicitRetry.priorAttemptRef } : {}),
            authority_ref: input.authorization!.callerAuthorityRef } },
      } }, input.signal));
      const failure = ownerFailure(workflowReply);
      results.push({ request, action, accepted: !failure, error: failure, evidenceRefs: [action.recordId, receiptRef, ...request.proofRefs ?? []], workflowReply, dispatchedInput, receiptRef, attemptRef, status: failure ? 'failed' : 'completed' });
      lifecycle('settled');
    } catch (error) {
      if (!admitted) {
        input.authorization!.pending.delete(capabilityKey);
        input.observe?.({ event: 'chat.action_denied', address: request.capabilityRef.canonicalAddress, reason_ref: 'owner-slot-hydration-transport-failure' });
      }
      lifecycle('settled');
      // Delivery after irreversible dispatch is at-least-once. Read the original
      // caller-owned receipt first; without it, automatic retry is forbidden.
      const candidateReceipt = admitted && input.readReceipt ? replyPayload(await input.readReceipt(receiptRef).catch(() => null)) : null;
      const evidence = record(candidateReceipt) && record(candidateReceipt.evidence) ? candidateReceipt.evidence : null;
      const receipt = record(candidateReceipt) && candidateReceipt.kind === 'workflow_execution_receipt'
        && candidateReceipt.status === 'completed' && evidence
        && evidence.attempt_ref === attemptRef && evidence.turn_ref === context.turnId
        && evidence.round_ref === context.round && evidence.ordinal === index
        && evidence.authority_ref === context.callerAuthorityRef
        && readRef(evidence.capability_ref) !== null
        && sameCapabilityRef(readRef(evidence.capability_ref)!, request.capabilityRef)
        ? candidateReceipt : null;
      if (receipt) {
        const failure = ownerFailure(receipt);
        results.push({ request, action, accepted: !failure, error: failure, evidenceRefs: [action.recordId, receiptRef], workflowReply: receipt, dispatchedInput, receiptRef, attemptRef, status: failure ? 'failed' : 'completed' });
      }
      else results.push({ request, action, accepted: false, error: admitted ? 'unknown_outcome' : 'owner-slot hydration request failed', evidenceRefs: [action.recordId, ...(admitted ? [receiptRef] : [])], workflowReply: null, dispatchedInput, receiptRef, attemptRef, ...(admitted ? { status: 'unknown_outcome' } : {}) });
    }
  }
  return results;
}
