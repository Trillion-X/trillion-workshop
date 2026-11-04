// PORTED FROM: bitfield-packages/packages/conversations/do-work/addressed-exchange-owner-actions.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';

export const UPSERT_ADDRESSED_EXCHANGE_CONVERSATION_ACTION_ID =
  'action:conversations.upsert-addressed-exchange-conversation';
export const APPEND_ADDRESSED_EXCHANGE_TURNS_ACTION_ID =
  'action:conversations.append-addressed-exchange-turns';
export const PUBLISH_ADDRESSED_EXCHANGE_PROJECTIONS_ACTION_ID =
  'action:conversations.publish-addressed-exchange-projections';

const UPSERT_STRINGS = [
  'conversation_ref',
  'title',
  'last_message_preview',
  'last_activity_at',
  'created_at',
  'updated_at',
] as const;

const UPSERT_REQUIRED_ARRAYS = [
  'participant_refs',
  'way_refs',
  'service_connection_refs',
] as const;

const UPSERT_OPTIONAL_STRINGS = [
  'message_page_ref',
  'cursor_ref',
  'project_slug',
  'project_name',
  'access_scope_ref',
  'state_ref',
  'consent_state_ref',
] as const;

const UPSERT_OPTIONAL_ARRAYS = [
  'proof_refs',
  'blocker_refs',
  'handoff_refs',
  'route_refs',
  'source_refs',
] as const;

const TURN_REQUIRED_STRINGS = [
  'turn_ref',
  'conversation_ref',
  'author_ref',
  'content',
  'occurred_at',
] as const;

const TURN_OPTIONAL_ARRAYS = [
  'addressed_participant_refs',
  'correlation_refs',
  'source_refs',
  'delivery_receipt_refs',
] as const;

const TURN_OPTIONAL_STRINGS = [
  'role',
  'speaker_ref',
  'parent_turn_ref',
  'effect_receipt_ref',
] as const;

export interface AddressedExchangeConversationInput {
  conversation_ref: string;
  participant_refs: string[];
  way_refs: string[];
  service_connection_refs: string[];
  title: string;
  last_message_preview: string;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  message_page_ref?: string;
  cursor_ref?: string;
  project_slug?: string;
  project_name?: string;
  proof_refs?: string[];
  blocker_refs?: string[];
  handoff_refs?: string[];
  route_refs?: string[];
  access_scope_ref?: string;
  source_refs?: string[];
  state_ref?: string;
  consent_state_ref?: string;
}

export interface AddressedExchangeTurnInput {
  turn_ref: string;
  conversation_ref: string;
  /** Caller-defined relationship label. This adapter does not constrain its vocabulary. */
  role?: string;
  author_ref: string;
  /** Independent identity of the human/system speaking, when distinct from authorship. */
  speaker_ref?: string;
  content: string;
  sequence: number;
  occurred_at: string;
  parent_turn_ref?: string;
  correlation_refs?: string[];
  addressed_participant_refs?: string[];
  source_refs?: string[];
  delivery_receipt_refs?: string[];
  /** Opaque record reference. The adapter never accepts an inlined execution object. */
  effect_receipt_ref?: string;
}

export interface AppendAddressedExchangeTurnsInput {
  turn_records: AddressedExchangeTurnInput[];
  message_page_ref: string;
  conversation_ref: string;
  message_refs: string[];
  next_cursor_ref: string;
}

export type ConversationOwnerActionDispatcher = (
  definitionId: string,
  input: Record<string, unknown>,
) => Promise<unknown> | unknown;

function failure(field: string, reason: string): never {
  throw new Error(`conversations-owner-input-invalid:${field}:${reason}`);
}

function readObject(value: AddressedExchangeConversationInput | AppendAddressedExchangeTurnsInput) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    failure('input', 'object-required');
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string) {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    failure(field, 'nonempty-string-required');
  }
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  failureField = field,
) {
  if (record[field] === undefined) return;
  if (typeof record[field] !== 'string' || (record[field] as string).length === 0) {
    failure(failureField, 'nonempty-string-required');
  }
}

function requireStringArray(
  record: Record<string, unknown>,
  field: string,
  failureField = field,
) {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    failure(failureField, 'string-array-required');
  }
}

function optionalStringArray(
  record: Record<string, unknown>,
  field: string,
  failureField = field,
) {
  if (record[field] === undefined) return;
  requireStringArray(record, field, failureField);
}

export function validateAddressedExchangeConversationInput(
  value: AddressedExchangeConversationInput,
): AddressedExchangeConversationInput {
  const record = readObject(value);
  for (const field of UPSERT_STRINGS) requireString(record, field);
  for (const field of UPSERT_REQUIRED_ARRAYS) requireStringArray(record, field);
  for (const field of UPSERT_OPTIONAL_STRINGS) optionalString(record, field);
  for (const field of UPSERT_OPTIONAL_ARRAYS) optionalStringArray(record, field);

  const allowed = new Set([
    ...UPSERT_STRINGS,
    ...UPSERT_REQUIRED_ARRAYS,
    ...UPSERT_OPTIONAL_STRINGS,
    ...UPSERT_OPTIONAL_ARRAYS,
  ]);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) failure(field, 'unexpected-field');
  }
  return value;
}

function validateTurn(
  value: AddressedExchangeTurnInput,
  index: number,
): AddressedExchangeTurnInput {
  const fieldPrefix = `turn_records.${index}`;
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    failure(fieldPrefix, 'object-required');
  }
  const record = value as unknown as Record<string, unknown>;
  for (const field of TURN_REQUIRED_STRINGS) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) {
      failure(`${fieldPrefix}.${field}`, 'nonempty-string-required');
    }
  }
  const sequence = record.sequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    failure(`${fieldPrefix}.sequence`, 'nonnegative-integer-required');
  }
  for (const field of TURN_OPTIONAL_ARRAYS) {
    if (record[field] !== undefined) {
      requireStringArray(record, field, `${fieldPrefix}.${field}`);
    }
  }
  for (const field of TURN_OPTIONAL_STRINGS) {
    if (record[field] !== undefined) optionalString(record, field, `${fieldPrefix}.${field}`);
  }

  const allowed = new Set([
    ...TURN_REQUIRED_STRINGS,
    'sequence',
    ...TURN_OPTIONAL_STRINGS,
    ...TURN_OPTIONAL_ARRAYS,
  ]);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) failure(`${fieldPrefix}.${field}`, 'unexpected-field');
  }
  return value;
}

export function validateAppendAddressedExchangeTurnsInput(
  value: AppendAddressedExchangeTurnsInput,
): AppendAddressedExchangeTurnsInput {
  const record = readObject(value);
  for (const field of ['message_page_ref', 'conversation_ref', 'next_cursor_ref']) {
    requireString(record, field);
  }
  requireStringArray(record, 'message_refs');
  if (!Array.isArray(record.turn_records) || record.turn_records.length === 0) {
    failure('turn_records', 'nonempty-array-required');
  }
  if (record.turn_records.length > 512) {
    failure('turn_records', 'max-512-turns');
  }

  const turns = record.turn_records.map((turn, index) => validateTurn(turn, index));
  const turnRefs = new Set<string>();
  let previousSequence: number | undefined;
  for (const [index, turn] of turns.entries()) {
    if (turnRefs.has(turn.turn_ref)) {
      failure(`turn_records.${index}.turn_ref`, 'duplicate-turn-ref');
    }
    turnRefs.add(turn.turn_ref);
    if (turn.conversation_ref !== value.conversation_ref) {
      failure(`turn_records.${index}.conversation_ref`, 'conversation-ref-mismatch');
    }
    if (previousSequence !== undefined && turn.sequence <= previousSequence) {
      failure(`turn_records.${index}.sequence`, 'strictly-increasing-sequence-required');
    }
    previousSequence = turn.sequence;
  }

  const orderedTurnRefs = turns.map((turn) => turn.turn_ref);
  if (value.message_refs.length !== orderedTurnRefs.length ||
      value.message_refs.some((ref, index) => ref !== orderedTurnRefs[index])) {
    failure('message_refs', 'ordered-turn-refs-required');
  }

  const allowed = new Set([
    'turn_records',
    'message_page_ref',
    'conversation_ref',
    'message_refs',
    'next_cursor_ref',
  ]);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) failure(field, 'unexpected-field');
  }
  return value;
}

export async function dispatchConversationOwnerAction(
  definitionId: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: definitionId,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}

export async function upsertAddressedExchangeConversation(
  input: AddressedExchangeConversationInput,
  dispatch: ConversationOwnerActionDispatcher = dispatchConversationOwnerAction,
): Promise<unknown> {
  const validated = validateAddressedExchangeConversationInput(input);
  return dispatch(
    UPSERT_ADDRESSED_EXCHANGE_CONVERSATION_ACTION_ID,
    validated as unknown as Record<string, unknown>,
  );
}

export async function appendAddressedExchangeTurns(
  input: AppendAddressedExchangeTurnsInput,
  dispatch: ConversationOwnerActionDispatcher = dispatchConversationOwnerAction,
): Promise<unknown> {
  const validated = validateAppendAddressedExchangeTurnsInput(input);
  return dispatch(
    APPEND_ADDRESSED_EXCHANGE_TURNS_ACTION_ID,
    validated as unknown as Record<string, unknown>,
  );
}

export async function publishAddressedExchangeProjections(
  dispatch: ConversationOwnerActionDispatcher = dispatchConversationOwnerAction,
): Promise<unknown> {
  return dispatch(PUBLISH_ADDRESSED_EXCHANGE_PROJECTIONS_ACTION_ID, {});
}
