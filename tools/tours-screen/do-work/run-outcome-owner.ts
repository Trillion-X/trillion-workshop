import { sendRequestToBitfieldTarget, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { completionWriteForRun, type SuccessorTriggerDispatch, type SuccessorTriggerRefs } from './walkthrough-completion-writes.ts';
import { currentReadPrecondition } from './current-read-precondition.ts';

export const RUN_OUTCOME_REQUEST_SCHEMA = 'guided-overlay.run-outcome-request/v1';
export const RUN_OUTCOME_RECEIPT_SCHEMA = 'guided-overlay.run-outcome-receipt/v1';

export interface RunOutcomeRequest {
  readonly schema: typeof RUN_OUTCOME_REQUEST_SCHEMA;
  readonly run_id: string;
  readonly scope_ref: string;
  readonly definition_id: string;
  readonly definition_revision: number;
  readonly outcome: 'completed' | 'skipped';
  readonly destination_operation_ref: string | null;
  readonly destination_readback_ref: string | null;
  readonly successor_trigger_ref: string | null;
  readonly successor_dispatch: SuccessorTriggerDispatch | null;
  readonly source_event?: Readonly<Record<string, unknown>>;
  readonly compatibility_record?: { readonly address: string; readonly value_json: unknown } | null;
}

export interface RunOutcomeReceipt {
  readonly schema: typeof RUN_OUTCOME_RECEIPT_SCHEMA;
  readonly accepted: boolean;
  readonly deduplicated: boolean;
  readonly reason?: 'in-progress';
  readonly run_id: string;
  readonly definition_id: string;
  readonly definition_revision: number;
  readonly outcome: 'completed' | 'skipped';
  readonly destination_operation_ref: string | null;
  readonly destination_readback_ref: string | null;
  readonly successor_dispatch: SuccessorTriggerDispatch | null;
  readonly destination_readback: Readonly<Record<string, unknown>> | null;
  readonly successor_trigger_ref: string | null;
}

type JsonRecord = Record<string, unknown>;
type Sender = (request: { target: string; payload: JsonRecord }) => Promise<unknown>;

function record(value: unknown): JsonRecord {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as JsonRecord, b = right as JsonRecord;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameJson(a[key], b[key]));
}

function decodeSuccessorDispatch(
  value: unknown,
  sourceEvent: Readonly<Record<string, unknown>>,
): SuccessorTriggerDispatch | null {
  const dispatch = record(value);
  const event = record(dispatch.event);
  const refs = record(dispatch.refs);
  const refSource = Object.keys(refs).length ? refs : dispatch;
  const eventKind = optionalText(event.event_kind) ?? optionalText(sourceEvent.event_kind);
  const decodedRefs = {
    destination_operation_ref: optionalText(refSource.destination_operation_ref),
    destination_readback_ref: optionalText(refSource.destination_readback_ref),
    successor_trigger_ref: optionalText(refSource.successor_trigger_ref),
  };
  if (!eventKind || Object.values(decodedRefs).some((ref) => ref === null)) return null;
  return {
    event: { ...event, event_kind: eventKind },
    refs: decodedRefs as Required<SuccessorTriggerRefs>,
  };
}

export function normalizeRunOutcomeRequest(value: unknown): RunOutcomeRequest {
  const input = record(value);
  if (input.schema !== RUN_OUTCOME_REQUEST_SCHEMA) throw new Error('unsupported run outcome schema');
  if (!Number.isSafeInteger(input.definition_revision) || Number(input.definition_revision) < 1) {
    throw new Error('definition_revision must be a positive integer');
  }
  if (input.outcome !== 'completed' && input.outcome !== 'skipped') throw new Error('outcome is invalid');
  const compatibility = record(input.compatibility_record);
  const sourceEvent = record(input.source_event);
  const successorDispatch = decodeSuccessorDispatch(input.successor_dispatch, sourceEvent);
  const refs = successorDispatch?.refs ?? {
    destination_operation_ref: optionalText(input.destination_operation_ref),
    destination_readback_ref: optionalText(input.destination_readback_ref),
    successor_trigger_ref: optionalText(input.successor_trigger_ref),
  };
  if (input.outcome === 'completed'
    && (!successorDispatch || Object.values(refs).some((ref) => ref === null))) {
    throw new Error('completed outcomes require a successor event and destination/successor refs');
  }
  const normalized: RunOutcomeRequest = {
    schema: RUN_OUTCOME_REQUEST_SCHEMA,
    run_id: text(input.run_id, 'run_id'),
    scope_ref: text(input.scope_ref, 'scope_ref'),
    definition_id: text(input.definition_id, 'definition_id'),
    definition_revision: Number(input.definition_revision),
    outcome: input.outcome,
    destination_operation_ref: refs.destination_operation_ref,
    destination_readback_ref: refs.destination_readback_ref,
    successor_trigger_ref: refs.successor_trigger_ref,
    successor_dispatch: successorDispatch,
    source_event: sourceEvent,
    compatibility_record: null,
  };
  if (input.compatibility_record == null) return normalized;
  const completion = record(compatibility.value_json);
  const eventKind = text(completion.event_kind, 'completion event_kind');
  const expected = completionWriteForRun(eventKind, sourceEvent, normalized.outcome, normalized, successorDispatch);
  if (Object.keys(compatibility).length !== 2 || compatibility.address !== expected.address
    || !sameJson(compatibility.value_json, expected.value_json)) {
    throw new Error('completion record does not match this walkthrough run');
  }
  return { ...normalized, compatibility_record: expected };
}

function outcomeAddress(input: RunOutcomeRequest): string {
  return `package::guided-overlay::run-outcome::${encodeURIComponent(input.scope_ref)}::${encodeURIComponent(input.run_id)}`;
}

function immutableMatches(value: JsonRecord, input: RunOutcomeRequest): boolean {
  return value.run_id === input.run_id
    && value.definition_id === input.definition_id
    && value.definition_revision === input.definition_revision
    && value.outcome === input.outcome
    && optionalText(value.destination_operation_ref) === input.destination_operation_ref
    && optionalText(value.destination_readback_ref) === input.destination_readback_ref
    && optionalText(value.successor_trigger_ref) === input.successor_trigger_ref
    && JSON.stringify(decodeSuccessorDispatch(value.successor_dispatch, input.source_event ?? {}))
      === JSON.stringify(input.successor_dispatch);
}

export function runOutcomeReceipt(
  input: RunOutcomeRequest,
  deduplicated = false,
  destinationReadback: Readonly<Record<string, unknown>> | null = null,
): RunOutcomeReceipt {
  return {
    schema: RUN_OUTCOME_RECEIPT_SCHEMA, accepted: true, deduplicated,
    run_id: input.run_id, definition_id: input.definition_id, definition_revision: input.definition_revision,
    outcome: input.outcome, destination_operation_ref: input.destination_operation_ref,
    destination_readback_ref: input.destination_readback_ref, destination_readback: destinationReadback,
    successor_trigger_ref: input.successor_trigger_ref, successor_dispatch: input.successor_dispatch,
  };
}

function pendingReceipt(input: RunOutcomeRequest): RunOutcomeReceipt {
  return {
    ...runOutcomeReceipt(input, true), accepted: false, reason: 'in-progress', destination_readback: null,
  };
}

function priorReceipt(value: JsonRecord, sourceEvent: Readonly<Record<string, unknown>> = {}): RunOutcomeReceipt | null {
  if (value.kind !== 'walkthrough-run-outcome' || value.accepted !== true
    || value.schema !== RUN_OUTCOME_RECEIPT_SCHEMA || typeof value.run_id !== 'string'
    || typeof value.definition_id !== 'string' || !Number.isSafeInteger(value.definition_revision)
    || Number(value.definition_revision) < 1
    || (value.outcome !== 'completed' && value.outcome !== 'skipped')) return null;
  return {
    schema: RUN_OUTCOME_RECEIPT_SCHEMA, accepted: true, deduplicated: true,
    run_id: value.run_id, definition_id: value.definition_id, definition_revision: Number(value.definition_revision),
    outcome: value.outcome, destination_operation_ref: optionalText(value.destination_operation_ref),
    destination_readback_ref: optionalText(value.destination_readback_ref),
    destination_readback: value.destination_readback && typeof value.destination_readback === 'object'
      && !Array.isArray(value.destination_readback) ? value.destination_readback as JsonRecord : null,
    successor_trigger_ref: optionalText(value.successor_trigger_ref),
    successor_dispatch: decodeSuccessorDispatch(value.successor_dispatch ?? value, {
      ...record(value.source_event), ...sourceEvent,
    }),
  };
}

function pendingClaim(input: RunOutcomeRequest): JsonRecord {
  return {
    kind: 'walkthrough-run-outcome-pending', schema: RUN_OUTCOME_REQUEST_SCHEMA,
    run_id: input.run_id, definition_id: input.definition_id, definition_revision: input.definition_revision,
    outcome: input.outcome, destination_operation_ref: input.destination_operation_ref,
    destination_readback_ref: input.destination_readback_ref, successor_trigger_ref: input.successor_trigger_ref,
    successor_dispatch: input.successor_dispatch,
  };
}

function failedClaim(input: RunOutcomeRequest, error: unknown): JsonRecord {
  return {
    ...pendingClaim(input),
    kind: 'walkthrough-run-outcome-failed',
    retry_error: error instanceof Error ? error.message : String(error),
  };
}

function decodeReply(value: unknown): JsonRecord {
  const envelope = record(value);
  const bytes = envelope.payload;
  if (bytes instanceof Uint8Array) {
    const body = new TextDecoder().decode(bytes);
    return record(body.trim() ? JSON.parse(body) : {});
  }
  return envelope;
}

// No partition is named; the engine falls back to the envelope's own partition. See
// engine-operation-target/src/lib.rs:835 and its test at :2617.
async function readOutcome(address: string, send: Sender): Promise<JsonRecord> {
  const read = decodeReply(await send({ target: 'engine.operation.label-addressed', payload: {
    operation_label: 'engine.operation.read-current', address_label: address, address_mode: 'identity_text',
  } }));
  currentReadPrecondition(read);
  return read;
}

function existingReceipt(read: JsonRecord, input: RunOutcomeRequest): RunOutcomeReceipt | null {
  if (read.found !== true) return null;
  const existing = record(read.payload);
  const terminal = priorReceipt(existing, input.source_event ?? {});
  if (terminal) {
    if (!immutableMatches(existing, input)) throw new Error('run_id already has a different terminal outcome');
    return terminal;
  }
  if (existing.kind === 'walkthrough-run-outcome-pending') {
    if (!immutableMatches(existing, input)) throw new Error('run_id already has a different terminal outcome');
    return pendingReceipt(input);
  }
  if (existing.kind === 'walkthrough-run-outcome-failed') {
    if (!immutableMatches(existing, input)) throw new Error('run_id already has a different terminal outcome');
    return null;
  }
  throw new Error('run_id already has an unrecognized terminal state');
}

function requireAccepted(reply: JsonRecord, ref: string): JsonRecord {
  if (reply.accepted !== true) throw new Error(`owner ${ref} did not accept the terminal handoff`);
  return reply;
}

export async function runOutcomeOwnerTarget(
  value: unknown,
  _context: BitfieldRuntimeContext | undefined,
  send: Sender = sendRequestToBitfieldTarget as Sender,
): Promise<RunOutcomeReceipt> {
  const input = normalizeRunOutcomeRequest(value);
  const address = outcomeAddress(input);
  const initial = await readOutcome(address, send);
  const existing = existingReceipt(initial, input);
  if (existing) return existing;
  const initialHash = currentReadPrecondition(initial);

  const claimWrite = decodeReply(await send({ target: 'engine.operation.label-addressed', payload: {
    operation_label: 'engine.operation.write-batch', writes: [{
      address_label: address, address_mode: 'identity_text', path_labels: ['current-item', 'published-record'],
      payload: pendingClaim(input), expected_current: { payload_hash_base64: initialHash },
    }],
  } }));
  if (claimWrite.write_count !== 1 && claimWrite.writeCount !== 1) {
    const afterRace = existingReceipt(await readOutcome(address, send), input);
    if (afterRace) return afterRace;
    throw new Error('run outcome claim was not persisted');
  }
  const claimed = await readOutcome(address, send);
  const claimHash = currentReadPrecondition(claimed);
  if (!existingReceipt(claimed, input)?.reason) throw new Error('run outcome claim was replaced before execution');

  const actuation = {
    run_id: input.run_id, definition_id: input.definition_id, definition_revision: input.definition_revision,
    scope_ref: input.scope_ref, outcome: input.outcome, source_event: input.source_event,
    successor_dispatch: input.successor_dispatch, idempotency_key: input.run_id,
  };
  const successorEvent = input.successor_dispatch
    ? {
        ...input.source_event,
        ...input.successor_dispatch.event,
        event_kind: input.successor_dispatch.event.event_kind,
        scope_ref: input.scope_ref,
        definition_id: input.definition_id,
        definition_revision: input.definition_revision,
        run_id: input.run_id,
      }
    : null;
  const markFailed = async (error: unknown) => {
    await send({ target: 'engine.operation.label-addressed', payload: {
      operation_label: 'engine.operation.write-batch', writes: [{
        address_label: address, address_mode: 'identity_text', path_labels: ['current-item', 'published-record'],
        payload: failedClaim(input, error), expected_current: { payload_hash_base64: claimHash },
      }],
    } });
  };
  let destinationReadback: Readonly<Record<string, unknown>> | null = null;
  try {
    if (input.destination_operation_ref) {
      requireAccepted(decodeReply(await send({ target: input.destination_operation_ref, payload: actuation })), input.destination_operation_ref);
    }
    if (input.destination_readback_ref) {
      destinationReadback = requireAccepted(
        decodeReply(await send({ target: input.destination_readback_ref, payload: actuation })),
        input.destination_readback_ref,
      );
    }
    if (input.successor_trigger_ref) {
      requireAccepted(decodeReply(await send({
        target: input.successor_trigger_ref,
        payload: successorEvent ?? actuation,
      })), input.successor_trigger_ref);
    }
  } catch (error) {
    await markFailed(error);
    throw error;
  }
  const receipt = runOutcomeReceipt(input, false, destinationReadback);
  const writes: JsonRecord[] = [{
    address_label: address, address_mode: 'identity_text', path_labels: ['current-item', 'published-record'],
    payload: { kind: 'walkthrough-run-outcome', ...receipt }, expected_current: { payload_hash_base64: claimHash },
  }];
  if (input.compatibility_record) writes.push({
    address_label: input.compatibility_record.address, address_mode: 'identity_text',
    path_labels: ['current-item', 'published-record'], payload: input.compatibility_record.value_json,
  });
  let finalWrite: JsonRecord;
  try {
    finalWrite = decodeReply(await send({ target: 'engine.operation.label-addressed', payload: {
      operation_label: 'engine.operation.write-batch', writes,
    } }));
  } catch (error) {
    await markFailed(error);
    throw error;
  }
  if (finalWrite.write_count === writes.length || finalWrite.writeCount === writes.length) return receipt;
  await markFailed(new Error('run outcome terminal receipt was not persisted'));
  const afterFinalRace = existingReceipt(await readOutcome(address, send), input);
  if (afterFinalRace) return afterFinalRace;
  throw new Error('run outcome terminal receipt was not persisted');
}
