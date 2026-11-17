import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  decodeAddressedExchangeConversation,
  decodeAddressedExchangeTurn,
  type AddressedExchangeConversation,
  type AddressedExchangeTurn,
} from '../read-data/read-addressed-exchange-ledger';
import {
  buildLedgerObservationsBundle,
  decodeLedgerObservationsBundle,
} from './build-ledger-observations-bundle';

const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';
const ENGINE_READ_CURRENT_OPERATION = 'engine.operation.read-current';
const LEDGER_INDEX_ADDRESS = 'package::chat::conversation-ledger::index';
// The derived observations projection the OCI materialize folds into the sidebar
// window (#56) — kept in the EXACT batch shape decode-addressed-exchange reads.
const LEDGER_OBSERVATIONS_ADDRESS = 'package::chat::conversation-ledger::observations';

const textDecoder = new TextDecoder();

interface TargetReplyEnvelope {
  payload?: Uint8Array;
}

interface LedgerIndexPayload {
  conversationIds: string[];
}

export interface RecordAddressedExchangeTurnsInput {
  conversation: Omit<AddressedExchangeConversation, 'turnIds'>;
  turns: readonly AddressedExchangeTurn[];
}

function randomId(prefix: string): string {
  const cryptoSource = globalThis.crypto;
  const value = cryptoSource && typeof cryptoSource.randomUUID === 'function'
    ? cryptoSource.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${value}`;
}

export function createAddressedExchangeConversationId(): string {
  return randomId('addressed-exchange');
}

export function createAddressedExchangeTurnId(): string {
  return randomId('addressed-exchange-turn');
}

export function addressedExchangeConversationAddress(conversationId: string): string {
  return `package::chat::conversation-ledger::conversation::${conversationId}`;
}

export function addressedExchangeTurnAddress(turnId: string): string {
  return `package::chat::conversation-ledger::turn::${turnId}`;
}

async function sendLabelOperation(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await sendRequestToBitfieldTarget({
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload,
  }) as TargetReplyEnvelope;
  const bytes = reply.payload;
  if (!(bytes instanceof Uint8Array)) return {};
  const parsed = JSON.parse(textDecoder.decode(bytes)) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

async function readCurrentPayload(addressLabel: string): Promise<unknown | null> {
  const result = await sendLabelOperation({
    operation_label: ENGINE_READ_CURRENT_OPERATION,
    address_label: addressLabel,
  });
  return result.found === true ? result.payload ?? null : null;
}

function decodeLedgerIndex(value: unknown): LedgerIndexPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { conversationIds: [] };
  const ids = (value as Record<string, unknown>).conversationIds;
  return {
    conversationIds: Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [],
  };
}

async function readLedgerIndex(): Promise<LedgerIndexPayload> {
  return decodeLedgerIndex(await readCurrentPayload(LEDGER_INDEX_ADDRESS));
}

async function readLedgerConversation(conversationId: string): Promise<AddressedExchangeConversation | null> {
  return decodeAddressedExchangeConversation(
    await readCurrentPayload(addressedExchangeConversationAddress(conversationId)),
  );
}

async function readLedgerTurn(turnId: string): Promise<AddressedExchangeTurn | null> {
  return decodeAddressedExchangeTurn(await readCurrentPayload(addressedExchangeTurnAddress(turnId)));
}

export async function readAddressedExchangeLedger(conversationId: string) {
  const conversation = await readLedgerConversation(conversationId);
  if (!conversation) return null;
  const turns = (await Promise.all(conversation.turnIds.map(readLedgerTurn)))
    .filter((turn): turn is AddressedExchangeTurn => turn !== null)
    .sort((left, right) => left.sequence - right.sequence);
  return { conversation, turns };
}

export async function recordAddressedExchangeTurns(input: RecordAddressedExchangeTurnsInput): Promise<void> {
  if (input.turns.length === 0) return;
  const [index, existingConversation, existingObservations] = await Promise.all([
    readLedgerIndex(),
    readLedgerConversation(input.conversation.conversationId),
    readCurrentPayload(LEDGER_OBSERVATIONS_ADDRESS),
  ]);
  const knownTurnIds = new Set(existingConversation?.turnIds ?? []);
  const nextTurnIds = [...knownTurnIds];
  for (const turn of input.turns) {
    if (!knownTurnIds.has(turn.turnId)) {
      knownTurnIds.add(turn.turnId);
      nextTurnIds.push(turn.turnId);
    }
  }
  const conversationIds = index.conversationIds.includes(input.conversation.conversationId)
    ? index.conversationIds
    : [...index.conversationIds, input.conversation.conversationId];
  const conversation: AddressedExchangeConversation = {
    ...input.conversation,
    turnIds: nextTurnIds,
  };

  // Maintain the derived observations projection so the OCI materialize can fold
  // this live conversation into the sidebar window (#56) — same write-batch, so
  // the projection never lags the canonical records.
  const observations = buildLedgerObservationsBundle(
    decodeLedgerObservationsBundle(existingObservations),
    conversation,
    input.turns,
  );

  await sendLabelOperation({
    operation_label: ENGINE_WRITE_BATCH_OPERATION,
    writes: [
      {
        address_label: LEDGER_INDEX_ADDRESS,
        path_labels: [],
        payload: { conversationIds },
      },
      {
        address_label: addressedExchangeConversationAddress(conversation.conversationId),
        path_labels: [],
        payload: conversation,
      },
      {
        address_label: LEDGER_OBSERVATIONS_ADDRESS,
        path_labels: [],
        payload: observations,
      },
      ...input.turns.map((turn) => ({
        address_label: addressedExchangeTurnAddress(turn.turnId),
        path_labels: [],
        payload: turn,
      })),
    ],
  });
}
