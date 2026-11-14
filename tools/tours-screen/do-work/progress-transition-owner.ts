import { sendRequestToBitfieldTarget, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { WALKTHROUGH_PROGRESS_KIND } from '../read-data/walkthrough-eeaf.ts';
import { currentReadPrecondition } from './current-read-precondition.ts';

export const PROGRESS_TRANSITION_REQUEST_SCHEMA = 'guided-overlay.progress-transition-request/v1';
export const PROGRESS_TRANSITION_RECEIPT_SCHEMA = 'guided-overlay.progress-transition-receipt/v1';

export interface ProgressTransitionRequest {
  readonly schema: typeof PROGRESS_TRANSITION_REQUEST_SCHEMA;
  readonly run_id: string;
  readonly scope_ref: string;
  readonly definition_id: string;
  readonly definition_revision: number;
  readonly expected_cursor_revision: number;
  readonly from_step_id: string;
  readonly to_step_id: string;
  readonly history: readonly string[];
  readonly status: 'active' | 'complete';
  readonly cause: 'advance' | 'back';
  readonly once_key?: string | null;
}

export interface ProgressTransitionReceipt {
  readonly schema: typeof PROGRESS_TRANSITION_RECEIPT_SCHEMA;
  readonly accepted: boolean;
  readonly deduplicated: boolean;
  readonly transition_ref: string;
  readonly run_id: string;
  readonly definition_id: string;
  readonly cursor_revision: number;
  readonly current_step_id: string;
  readonly history: readonly string[];
  readonly status: 'active' | 'complete';
  readonly reason?: 'stale-cursor' | 'cursor-mismatch';
}

type JsonRecord = Record<string, unknown>;
type Sender = (request: { target: string; payload: JsonRecord }) => Promise<unknown>;

export interface ProgressStateRecord extends JsonRecord {
  kind: typeof WALKTHROUGH_PROGRESS_KIND;
  scope_ref: string;
  definition_id: string;
  definition_revision: number;
  run_id: string;
  /** Canonical suppression state, keyed by the trigger DATA identity. */
  consumed_trigger_keys: string[];
  /** Read-model compatibility projection for callers that still consume the authored field. */
  consumed_once_keys: string[];
  current_step_id: string;
  history: string[];
  status: 'active' | 'complete';
  cursor_revision: number;
  transition_history: ProgressTransitionReceipt[];
}

function record(value: unknown): JsonRecord {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function transitionRef(request: ProgressTransitionRequest): string {
  return [request.scope_ref, request.definition_id, request.definition_revision, request.run_id,
    request.expected_cursor_revision, request.from_step_id, request.to_step_id, request.status, request.cause]
    .map((part) => encodeURIComponent(String(part))).join('::');
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function integerOr(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? Number(value) : fallback;
}

/**
 * Move an aggregate progress record to this scoped run without inferring a
 * lifecycle label. Missing identity fields come from the requested run; a
 * nested cursor is selected only by the same opaque definition id.
 */
export function migrateProgressState(
  currentValue: unknown,
  identity: Pick<ProgressTransitionRequest, 'scope_ref' | 'definition_id' | 'definition_revision' | 'run_id'>,
): ProgressStateRecord {
  const source = record(currentValue);
  const nested = record(source.cursors)[identity.definition_id] ?? source;
  const cursor = record(nested);
  const triggerKeys = stringArray((cursor.consumed_trigger_keys ?? cursor.consumed_once_keys ?? source.consumed_once_keys));
  const transitionHistory = Array.isArray(source.transition_history)
    ? source.transition_history.filter((value): value is ProgressTransitionReceipt =>
      record(value).schema === PROGRESS_TRANSITION_RECEIPT_SCHEMA)
    : [];
  return {
    kind: WALKTHROUGH_PROGRESS_KIND,
    scope_ref: identity.scope_ref,
    definition_id: identity.definition_id,
    definition_revision: identity.definition_revision,
    run_id: identity.run_id,
    consumed_trigger_keys: [...new Set(triggerKeys)].sort(),
    consumed_once_keys: [...new Set(triggerKeys)].sort(),
    current_step_id: textOrEmpty(cursor.current_step_id ?? cursor.currentStepId),
    history: stringArray(cursor.history),
    status: cursor.status === 'complete' ? 'complete' : 'active',
    cursor_revision: integerOr(cursor.cursor_revision ?? cursor.cursorRevision, 0),
    transition_history: transitionHistory,
  };
}

export function normalizeProgressTransitionRequest(value: unknown): ProgressTransitionRequest {
  const input = record(value);
  if (input.schema !== PROGRESS_TRANSITION_REQUEST_SCHEMA) throw new Error('unsupported progress transition schema');
  if (!Number.isSafeInteger(input.definition_revision) || Number(input.definition_revision) < 1) {
    throw new Error('definition_revision must be a positive integer');
  }
  if (!Number.isSafeInteger(input.expected_cursor_revision) || Number(input.expected_cursor_revision) < 0) {
    throw new Error('expected_cursor_revision must be a non-negative integer');
  }
  if (input.status !== 'active' && input.status !== 'complete') throw new Error('status is invalid');
  if (input.cause !== 'advance' && input.cause !== 'back') throw new Error('cause is invalid');
  return {
    schema: PROGRESS_TRANSITION_REQUEST_SCHEMA,
    run_id: requiredText(input.run_id, 'run_id'),
    scope_ref: requiredText(input.scope_ref, 'scope_ref'),
    definition_id: requiredText(input.definition_id, 'definition_id'),
    definition_revision: Number(input.definition_revision),
    expected_cursor_revision: Number(input.expected_cursor_revision),
    from_step_id: requiredText(input.from_step_id, 'from_step_id'),
    to_step_id: requiredText(input.to_step_id, 'to_step_id'),
    history: Array.isArray(input.history) ? input.history.filter((step): step is string => typeof step === 'string') : [],
    status: input.status,
    cause: input.cause,
    once_key: typeof input.once_key === 'string' ? input.once_key : null,
  };
}

export function walkthroughProgressAddress(
  scopeRef: string,
  definitionId: string,
  definitionRevision: number,
  runId: string,
): string {
  return ['package::guided-overlay::walkthrough-progress', encodeURIComponent(scopeRef),
    encodeURIComponent(definitionId), encodeURIComponent(String(definitionRevision)), encodeURIComponent(runId)].join('::');
}

export function emptyProgressState(): ProgressStateRecord {
  return {
    kind: WALKTHROUGH_PROGRESS_KIND, scope_ref: '', definition_id: '', definition_revision: 0, run_id: '',
    consumed_trigger_keys: [], consumed_once_keys: [], current_step_id: '', history: [], status: 'active', cursor_revision: 0,
    transition_history: [],
  };
}

export function applyProgressTransition(
  currentValue: unknown,
  input: ProgressTransitionRequest,
): { readonly state: ProgressStateRecord; readonly receipt: ProgressTransitionReceipt } {
  const rawCurrent = record(currentValue);
  const current = rawCurrent.definition_id || rawCurrent.cursors
    ? migrateProgressState(rawCurrent, input)
    : { ...emptyProgressState(), ...rawCurrent } as ProgressStateRecord;
  current.consumed_trigger_keys = stringArray(current.consumed_trigger_keys);
  current.consumed_once_keys = stringArray(current.consumed_once_keys);
  current.history = Array.isArray(current.history)
    ? current.history.filter((value): value is string => typeof value === 'string') : [];
  current.transition_history = Array.isArray(current.transition_history)
    ? current.transition_history.filter((value): value is ProgressTransitionReceipt => record(value).schema === PROGRESS_TRANSITION_RECEIPT_SCHEMA) : [];
  const ref = transitionRef(input);
  const prior = current.transition_history.find((receipt) => receipt.transition_ref === ref);
  if (prior) return { state: current, receipt: { ...prior, deduplicated: true } };

  const currentRevision = Number.isSafeInteger(current.cursor_revision) ? Number(current.cursor_revision) : 0;
  const currentStepId = typeof current.current_step_id === 'string' && current.current_step_id
    ? current.current_step_id : input.from_step_id;
  const currentStatus = current.status === 'complete' ? 'complete' : 'active';
  if (input.expected_cursor_revision !== currentRevision || (currentRevision > 0 && currentStepId !== input.from_step_id)) {
    return { state: current, receipt: {
      schema: PROGRESS_TRANSITION_RECEIPT_SCHEMA, accepted: false, deduplicated: false, transition_ref: ref,
      run_id: input.run_id, definition_id: input.definition_id, cursor_revision: currentRevision,
      current_step_id: currentStepId, history: current.history, status: currentStatus,
      reason: input.expected_cursor_revision !== currentRevision ? 'stale-cursor' : 'cursor-mismatch',
    } };
  }
  const receipt: ProgressTransitionReceipt = {
    schema: PROGRESS_TRANSITION_RECEIPT_SCHEMA, accepted: true, deduplicated: false, transition_ref: ref,
    run_id: input.run_id, definition_id: input.definition_id, cursor_revision: currentRevision + 1,
    current_step_id: input.to_step_id, history: [...input.history], status: input.status,
  };
  const consumed = new Set(current.consumed_trigger_keys);
  if (input.once_key) consumed.add(input.once_key);
  const consumedTriggerKeys = [...consumed].sort();
  return { state: {
    kind: WALKTHROUGH_PROGRESS_KIND, scope_ref: input.scope_ref, definition_id: input.definition_id,
    definition_revision: input.definition_revision, run_id: input.run_id,
    consumed_trigger_keys: consumedTriggerKeys, consumed_once_keys: consumedTriggerKeys,
    current_step_id: input.to_step_id, history: [...input.history], status: input.status,
    cursor_revision: receipt.cursor_revision, transition_history: [...current.transition_history, receipt],
  }, receipt };
}

function decodeReply(value: unknown): JsonRecord {
  const envelope = record(value);
  const bytes = envelope.payload;
  if (bytes instanceof Uint8Array) {
    const text = new TextDecoder().decode(bytes);
    return record(text.trim() ? JSON.parse(text) : {});
  }
  return envelope;
}

// No partition is named. `engine.operation.label-addressed` treats `partition_label` as
// optional and falls back to the partition of the envelope the request arrived on, which
// is the serving app's own store. Naming one answers a question the engine never asked.
async function readProgressState(address: string, send: Sender): Promise<JsonRecord> {
  const read = decodeReply(await send({
    target: 'engine.operation.label-addressed',
    payload: { operation_label: 'engine.operation.read-current', address_label: address, address_mode: 'identity_text' },
  }));
  currentReadPrecondition(read);
  if (read.found === true && (!read.payload || typeof read.payload !== 'object' || Array.isArray(read.payload))) {
    throw new Error('Walkthrough state could not be verified. Try again.');
  }
  return read;
}

export async function progressTransitionOwnerTarget(
  value: unknown,
  _context: BitfieldRuntimeContext | undefined,
  send: Sender = sendRequestToBitfieldTarget as Sender,
): Promise<ProgressTransitionReceipt> {
  const input = normalizeProgressTransitionRequest(value);
  const address = walkthroughProgressAddress(input.scope_ref, input.definition_id, input.definition_revision, input.run_id);
  const read = await readProgressState(address, send);
  const result = applyProgressTransition(read.found === true ? read.payload : null, input);
  if (!result.receipt.accepted || result.receipt.deduplicated) return result.receipt;
  const hash = currentReadPrecondition(read);
  const write = decodeReply(await send({
    target: 'engine.operation.label-addressed',
    payload: { operation_label: 'engine.operation.write-batch', writes: [{
      address_label: address, address_mode: 'identity_text', path_labels: ['current-item', 'published-record'],
      payload: result.state, expected_current: { payload_hash_base64: hash },
    }] },
  }));
  if (write.write_count === 1 || write.writeCount === 1) return result.receipt;
  const afterRace = await readProgressState(address, send);
  const replay = applyProgressTransition(afterRace.found === true ? afterRace.payload : null, input).receipt;
  if (replay.accepted && !replay.deduplicated) {
    throw new Error('Walkthrough progress was not saved. Try again.');
  }
  return replay;
}
