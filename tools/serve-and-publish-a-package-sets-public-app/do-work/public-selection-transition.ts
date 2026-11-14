import {
  readTrustedRuntimePartitionIfPresent,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import { Buffer } from 'node:buffer';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  type EngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';

type JsonRecord = Record<string, unknown>;
type ExactRef = { address: string; revision: string; object_hash: string };
type Sender = (request: unknown) => Promise<unknown>;
type RuntimeContext = BitfieldRuntimeContext & {
  packageData?: { things?: unknown[] };
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class PublicSelectionTransitionError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
  }
}

const record = (value: unknown): JsonRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new PublicSelectionTransitionError('INVALID_VALUE', label);
  }
  return value.trim();
};

const generation = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new PublicSelectionTransitionError('INVALID_GENERATION', label);
  }
  return Number(value);
};

const exactRef = (value: unknown, label: string): ExactRef => {
  const candidate = record(value);
  if (!candidate || Object.keys(candidate).sort().join(',') !== 'address,object_hash,revision') {
    throw new PublicSelectionTransitionError('INVALID_REF', label);
  }
  return {
    address: text(candidate.address, `${label}.address`),
    revision: text(candidate.revision, `${label}.revision`),
    object_hash: text(candidate.object_hash, `${label}.object_hash`),
  };
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = record(value);
  if (object) {
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;

function trustedPartition(context: RuntimeContext | undefined): string {
  // The runtime is the first and best source. When a published buyer surface runs
  // without one, the partition comes from the durable per-publication
  // owner-binding record, never from a literal. Neither present means refuse.
  const supplied = readTrustedRuntimePartitionIfPresent(context);
  if (supplied !== undefined) return supplied;
  const things = context?.packageData?.things;
  const source = Array.isArray(things)
    ? things.find((thing) => {
      const candidate = record(thing);
      return candidate && Array.isArray(candidate.path) && candidate.path.at(-1) === 'publication-owner-binding';
    })
    : null;
  const encoded = record(source)?.payload_base64;
  if (typeof encoded === 'string' && encoded) {
    const decoded = record(JSON.parse(decoder.decode(Uint8Array.from(Buffer.from(encoded, 'base64')))));
    const bound = decoded?.partition_label;
    if (typeof bound === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bound)) return bound;
  }
  throw new PublicSelectionTransitionError('OWNER_BINDING_MISSING', 'trusted partition');
}

function replyBytes(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  const payload = record(reply)?.payload;
  if (payload !== undefined) return replyBytes(payload);
  throw new PublicSelectionTransitionError('OWNER_READ_FAILED', 'engine reply lacks bytes');
}

async function current(partition: string, address: string, sender: Sender): Promise<EngineReadCurrentReply> {
  return decodeEngineReadCurrentReply(replyBytes(await sender(buildEngineReadCurrentRequestFromLabels(partition, address))));
}

function parse(currentValue: EngineReadCurrentReply, label: string): JsonRecord | null {
  if (!currentValue.found || currentValue.payload === null) return null;
  try {
    const value = record(JSON.parse(decoder.decode(currentValue.payload)));
    if (!value) throw new Error('not an object');
    return value;
  } catch {
    throw new PublicSelectionTransitionError('OWNER_RECORD_INVALID', label);
  }
}

function basis(currentValue: EngineReadCurrentReply): Uint8Array | null {
  if (!currentValue.found) return null;
  if (!currentValue.payloadHash) {
    throw new PublicSelectionTransitionError('ATOMIC_BASIS_MISSING', 'current selection');
  }
  return currentValue.payloadHash;
}

function requireSelection(value: JsonRecord | null, address: string): JsonRecord {
  if (!value || value.kind !== 'hosted-public-app.public-selection/v1') {
    throw new PublicSelectionTransitionError('SELECTION_INVALID', address);
  }
  if (text(value.address, 'selection.address') !== address) {
    throw new PublicSelectionTransitionError('SELECTION_INVALID', 'address mismatch');
  }
  generation(value.generation, 'selection.generation');
  exactRef(value.surface_ref, 'selection.surface_ref');
  exactRef(value.stable_release_ref, 'selection.stable_release_ref');
  if (!Array.isArray(value.candidate_release_refs)) {
    throw new PublicSelectionTransitionError('SELECTION_INVALID', 'candidate_release_refs');
  }
  value.candidate_release_refs.forEach((entry, index) => exactRef(entry, `selection.candidate_release_refs[${index}]`));
  exactRef(value.allocation_policy_ref, 'selection.allocation_policy_ref');
  exactRef(value.route_contract_ref, 'selection.route_contract_ref');
  return value;
}

function request(value: unknown, allowed: readonly string[]): JsonRecord {
  const input = record(value);
  if (!input || encoder.encode(JSON.stringify(input)).byteLength > 256 * 1024) {
    throw new PublicSelectionTransitionError('REQUEST_INVALID', 'request');
  }
  const extras = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extras.length) throw new PublicSelectionTransitionError('UNTRUSTED_FIELD', extras.join(','));
  return input;
}

function deterministicAddress(kind: string, selectionAddress: string, idempotencyKey: string): string {
  const safe = Buffer.from(`${selectionAddress}\u0000${idempotencyKey}`).toString('base64url');
  if (safe.length > 768) throw new PublicSelectionTransitionError('INVALID_VALUE', 'idempotency_key');
  return `package::hosted-public-app::${kind}::${safe}`;
}

export type ReservePublicSelectionInput = {
  selection_ref: ExactRef;
  expected_generation: number;
  expected_selection_digest: string;
  proposed_transition_ref: ExactRef;
  admission_evidence_set_ref: ExactRef;
  idempotency_key: string;
};

export function reduceReservePublicSelectionTransition(
  selection: JsonRecord,
  selectionDigest: string,
  input: ReservePublicSelectionInput,
) {
  const expectedGeneration = generation(input.expected_generation, 'expected_generation');
  if (generation(selection.generation, 'selection.generation') !== expectedGeneration
    || selectionDigest !== text(input.expected_selection_digest, 'expected_selection_digest')) {
    return { status: 'conflict' as const, reason: 'stale-selection' };
  }
  if (selection.pending_transition_ref !== undefined) {
    return { status: 'conflict' as const, reason: 'transition-pending' };
  }
  const idempotencyKey = text(input.idempotency_key, 'idempotency_key');
  const reservationAddress = deterministicAddress('public-selection-reservation', text(selection.address, 'selection.address'), idempotencyKey);
  const reservationRef = { address: reservationAddress, revision: 'initial' };
  const nextSelection = {
    ...clone(selection),
    generation: expectedGeneration + 1,
    pending_transition_ref: reservationRef,
  };
  const reservation = {
    kind: 'hosted-public-app.public-selection-reservation/v1',
    address: reservationAddress,
    revision: 'initial',
    selection_ref: clone(input.selection_ref),
    previous_stable_release_ref: clone(selection.stable_release_ref),
    proposed_transition_ref: clone(input.proposed_transition_ref),
    admission_evidence_set_ref: clone(input.admission_evidence_set_ref),
    idempotency_key: idempotencyKey,
    expected_generation: expectedGeneration,
    expected_selection_digest: input.expected_selection_digest,
    reserved_generation: expectedGeneration + 1,
    status: 'pending',
  };
  return { status: 'accepted' as const, nextSelection, reservation, reservationRef };
}

async function readExactRef(partition: string, ref: ExactRef, label: string, sender: Sender): Promise<JsonRecord> {
  const observed = await current(partition, ref.address, sender);
  const value = parse(observed, label);
  if (!value || value.address !== ref.address || value.revision !== ref.revision || observed.contentHash !== ref.object_hash) {
    throw new PublicSelectionTransitionError('STALE_OR_SUBSTITUTED_REF', label);
  }
  return value;
}

async function acceptedOrConflict(
  partition: string,
  selectionAddress: string,
  receiptAddress: string,
  fingerprint: string,
  sender: Sender,
) {
  const [selectionCurrent, receiptCurrent] = await Promise.all([
    current(partition, selectionAddress, sender),
    current(partition, receiptAddress, sender),
  ]);
  const durableSelection = parse(selectionCurrent, selectionAddress);
  const durableReceipt = parse(receiptCurrent, receiptAddress);
  if (durableReceipt?.fingerprint === fingerprint && durableSelection) {
    return { status: 'accepted' as const, replay: true, selection: durableSelection, receipt: durableReceipt };
  }
  return { status: 'conflict' as const, conflict: true, selection: durableSelection };
}

export async function reservePublicSelectionTransitionTarget(
  input: unknown,
  context?: RuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
) {
  const payload = request(input, ['selection_ref', 'expected_generation', 'expected_selection_digest', 'proposed_transition_ref', 'admission_evidence_set_ref', 'idempotency_key']);
  const normalized: ReservePublicSelectionInput = {
    selection_ref: exactRef(payload.selection_ref, 'selection_ref'),
    expected_generation: generation(payload.expected_generation, 'expected_generation'),
    expected_selection_digest: text(payload.expected_selection_digest, 'expected_selection_digest'),
    proposed_transition_ref: exactRef(payload.proposed_transition_ref, 'proposed_transition_ref'),
    admission_evidence_set_ref: exactRef(payload.admission_evidence_set_ref, 'admission_evidence_set_ref'),
    idempotency_key: text(payload.idempotency_key, 'idempotency_key'),
  };
  const partition = trustedPartition(context);
  await Promise.all([
    readExactRef(partition, normalized.proposed_transition_ref, 'proposed_transition_ref', sender),
    readExactRef(partition, normalized.admission_evidence_set_ref, 'admission_evidence_set_ref', sender),
  ]);
  const before = await current(partition, normalized.selection_ref.address, sender);
  const selection = requireSelection(parse(before, normalized.selection_ref.address), normalized.selection_ref.address);
  if (before.contentHash !== normalized.selection_ref.object_hash) {
    return { status: 'conflict', conflict: true, reason: 'stale-selection-ref', current: selection };
  }
  const reduced = reduceReservePublicSelectionTransition(selection, before.contentHash ?? '', normalized);
  if (reduced.status === 'conflict') return { ...reduced, conflict: true, current: selection };
  const fingerprint = canonical(normalized);
  const receipt = { ...reduced.reservation, fingerprint };
  try {
    await sender(buildEngineWriteBatchRequestFromLabels([
      {
        partitionLabel: partition,
        addressLabel: normalized.selection_ref.address,
        pathLabels: ['current-item', 'published-record', 'hosted-public-app-public-selection'],
        payloadBytes: encoder.encode(JSON.stringify(reduced.nextSelection)),
        expectedCurrent: { payloadHash: basis(before) },
      },
      {
        partitionLabel: partition,
        addressLabel: receipt.address,
        pathLabels: ['current-item', 'published-record', 'hosted-public-app-public-selection-reservation'],
        payloadBytes: encoder.encode(JSON.stringify(receipt)),
        expectedCurrent: { payloadHash: null },
      },
    ]));
  } catch {
    return acceptedOrConflict(partition, normalized.selection_ref.address, receipt.address, fingerprint, sender);
  }
  const durable = await acceptedOrConflict(partition, normalized.selection_ref.address, receipt.address, fingerprint, sender);
  if (durable.status !== 'accepted') throw new PublicSelectionTransitionError('RESERVATION_READBACK_FAILED', receipt.address);
  return {
    ...durable,
    replay: false,
    reservation_ref: { address: receipt.address, revision: receipt.revision, object_hash: (await current(partition, receipt.address, sender)).contentHash },
    reserved_generation: reduced.nextSelection.generation,
    reserved_selection_digest: (await current(partition, normalized.selection_ref.address, sender)).contentHash,
  };
}

type TerminalMode = 'finalize' | 'reconcile';

async function terminalTransition(
  mode: TerminalMode,
  input: unknown,
  context: RuntimeContext | undefined,
  sender: Sender,
) {
  const allowed = mode === 'finalize'
    ? ['reservation_ref', 'expected_reserved_generation', 'provider_commit_ref', 'convergence_case_manifest_ref']
    : ['reservation_ref', 'expected_reserved_generation', 'provider_failure_or_readback_ref', 'recovery_policy_ref'];
  const payload = request(input, allowed);
  const reservationRef = exactRef(payload.reservation_ref, 'reservation_ref');
  const expectedGeneration = generation(payload.expected_reserved_generation, 'expected_reserved_generation');
  const terminalRef = exactRef(
    mode === 'finalize' ? payload.provider_commit_ref : payload.provider_failure_or_readback_ref,
    mode === 'finalize' ? 'provider_commit_ref' : 'provider_failure_or_readback_ref',
  );
  const policyRef = exactRef(
    mode === 'finalize' ? payload.convergence_case_manifest_ref : payload.recovery_policy_ref,
    mode === 'finalize' ? 'convergence_case_manifest_ref' : 'recovery_policy_ref',
  );
  const partition = trustedPartition(context);
  const [reservation, terminalEvidence, policy] = await Promise.all([
    readExactRef(partition, reservationRef, 'reservation_ref', sender),
    readExactRef(partition, terminalRef, 'terminal_evidence_ref', sender),
    readExactRef(partition, policyRef, 'terminal_policy_ref', sender),
  ]);
  if (reservation.kind !== 'hosted-public-app.public-selection-reservation/v1' || reservation.status !== 'pending') {
    throw new PublicSelectionTransitionError('RESERVATION_NOT_PENDING', reservationRef.address);
  }
  const selectionRef = exactRef(reservation.selection_ref, 'reservation.selection_ref');
  const before = await current(partition, selectionRef.address, sender);
  const selection = requireSelection(parse(before, selectionRef.address), selectionRef.address);
  if (generation(selection.generation, 'selection.generation') !== expectedGeneration
    || !same(selection.pending_transition_ref, { address: reservation.address, revision: reservation.revision })) {
    return { status: 'conflict', conflict: true, reason: 'stale-reservation', current: selection };
  }
  const transitionRef = exactRef(reservation.proposed_transition_ref, 'reservation.proposed_transition_ref');
  const transition = await readExactRef(partition, transitionRef, 'proposed_transition_ref', sender);
  const nextSelection = clone(selection);
  delete nextSelection.pending_transition_ref;
  nextSelection.generation = expectedGeneration + 1;
  if (mode === 'finalize') {
    nextSelection.stable_release_ref = exactRef(transition.target_release_ref, 'transition.target_release_ref');
    if (transition.allocation_policy_ref !== undefined) nextSelection.allocation_policy_ref = exactRef(transition.allocation_policy_ref, 'transition.allocation_policy_ref');
    if (transition.route_contract_ref !== undefined) nextSelection.route_contract_ref = exactRef(transition.route_contract_ref, 'transition.route_contract_ref');
  }
  const fingerprint = canonical({ mode, reservation_ref: reservationRef, expected_reserved_generation: expectedGeneration, terminal_ref: terminalRef, policy_ref: policyRef });
  const receiptAddress = `${reservation.address}::${mode}`;
  const receipt = {
    kind: `hosted-public-app.public-selection-${mode}-receipt/v1`,
    address: receiptAddress,
    revision: 'initial',
    fingerprint,
    reservation_ref: reservationRef,
    selection_ref: selectionRef,
    previous_stable_release_ref: clone(reservation.previous_stable_release_ref),
    stable_release_ref: clone(nextSelection.stable_release_ref),
    terminal_evidence_ref: terminalRef,
    policy_ref: policyRef,
    terminal_evidence_kind: terminalEvidence.kind,
    policy_kind: policy.kind,
    outcome: mode === 'finalize' ? 'selected' : 'stable-retained',
    finalized_generation: nextSelection.generation,
  };
  try {
    await sender(buildEngineWriteBatchRequestFromLabels([
      {
        partitionLabel: partition,
        addressLabel: selectionRef.address,
        pathLabels: ['current-item', 'published-record', 'hosted-public-app-public-selection'],
        payloadBytes: encoder.encode(JSON.stringify(nextSelection)),
        expectedCurrent: { payloadHash: basis(before) },
      },
      {
        partitionLabel: partition,
        addressLabel: receiptAddress,
        pathLabels: ['current-item', 'published-record', `hosted-public-app-public-selection-${mode}-receipt`],
        payloadBytes: encoder.encode(JSON.stringify(receipt)),
        expectedCurrent: { payloadHash: null },
      },
    ]));
  } catch {
    return acceptedOrConflict(partition, selectionRef.address, receiptAddress, fingerprint, sender);
  }
  const durable = await acceptedOrConflict(partition, selectionRef.address, receiptAddress, fingerprint, sender);
  if (durable.status !== 'accepted') throw new PublicSelectionTransitionError('TERMINAL_READBACK_FAILED', receiptAddress);
  return { ...durable, replay: false, transition_receipt_ref: { address: receiptAddress, revision: 'initial', object_hash: (await current(partition, receiptAddress, sender)).contentHash } };
}

export function finalizePublicSelectionTransitionTarget(input: unknown, context?: RuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  return terminalTransition('finalize', input, context, sender);
}

export function reconcilePublicSelectionTransitionTarget(input: unknown, context?: RuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  return terminalTransition('reconcile', input, context, sender);
}

export const publicSelectionTransitionAddresses = {
  reservation: (selectionAddress: string, idempotencyKey: string) => deterministicAddress('public-selection-reservation', selectionAddress, idempotencyKey),
};
