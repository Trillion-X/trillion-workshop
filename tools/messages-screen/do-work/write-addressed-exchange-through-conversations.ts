// PORTED FROM: bitfield-packages/packages/chat/do-work/write-addressed-exchange-through-conversations.ts @ e99ac5976
import {
  APPEND_ADDRESSED_EXCHANGE_TURNS_ACTION_ID,
  PUBLISH_ADDRESSED_EXCHANGE_PROJECTIONS_ACTION_ID,
  UPSERT_ADDRESSED_EXCHANGE_CONVERSATION_ACTION_ID,
  appendAddressedExchangeTurns,
  dispatchConversationOwnerAction,
  publishAddressedExchangeProjections,
  upsertAddressedExchangeConversation,
  validateAddressedExchangeConversationInput,
  validateAppendAddressedExchangeTurnsInput,
  type AddressedExchangeConversationInput,
  type AddressedExchangeTurnInput,
  type AppendAddressedExchangeTurnsInput,
  type ConversationOwnerActionDispatcher,
} from '../../conversations/do-work/addressed-exchange-owner-actions';

export interface ChatAddressedExchangeConversationDraft {
  conversationId: string;
  participantRefs: string[];
  wayRefs: string[];
  serviceConnectionRefs: string[];
  title: string;
  lastMessagePreview?: string;
  lastActivityAt?: string;
  createdAt?: string;
  updatedAt?: string;
  messagePageRef?: string;
  cursorRef?: string;
  projectSlug?: string;
  projectName?: string;
  proofRefs?: string[];
  blockerRefs?: string[];
  handoffRefs?: string[];
  routeRefs?: string[];
  accessScopeRef?: string;
  sourceRefs?: string[];
  stateRef?: string;
  consentStateRef?: string;
}

export interface ChatAddressedExchangeTurnDraft {
  turnId: string;
  conversationId: string;
  authorRef: string;
  content: string;
  sequence: number;
  createdAt: string;
  role?: string;
  speakerRef?: string;
  parentTurnId?: string;
  correlationRefs?: string[];
  addressedParticipantRefs?: string[];
  sourceRefs?: string[];
  effectReceiptRef?: string;
  deliveryReceiptRefs?: string[];
}

export interface WriteAddressedExchangeThroughConversationsInput {
  conversation: ChatAddressedExchangeConversationDraft;
  turns: ChatAddressedExchangeTurnDraft[];
  messagePageRef: string;
  nextCursorRef?: string;
}

export interface CanonicalChatMessageTurnSource {
  id: string;
  content: string;
  timestamp: string;
  role?: 'human' | 'assistant';
  canonicalRole?: string;
  speakerRef?: string;
  authorRef?: string;
  sourceRefs?: string[];
  addressedParticipantRefs?: string[];
  deliveryReceiptRefs?: string[];
  parentTurnRef?: string;
  correlationRefs?: string[];
  effectReceiptRef?: string;
  sequence?: number;
}

export { createChatAddressedExchangeConversationId, createChatAddressedExchangeTurnId } from './addressed-exchange-ids';

const CONVERSATION_FIELDS = new Set(Object.keys({
  conversationId: true,
  participantRefs: true,
  wayRefs: true,
  serviceConnectionRefs: true,
  title: true,
  lastMessagePreview: true,
  lastActivityAt: true,
  createdAt: true,
  updatedAt: true,
  messagePageRef: true,
  cursorRef: true,
  projectSlug: true,
  projectName: true,
  proofRefs: true,
  blockerRefs: true,
  handoffRefs: true,
  routeRefs: true,
  accessScopeRef: true,
  sourceRefs: true,
  stateRef: true,
  consentStateRef: true,
}));

const TURN_FIELDS = new Set(Object.keys({
  turnId: true,
  conversationId: true,
  authorRef: true,
  content: true,
  sequence: true,
  createdAt: true,
  role: true,
  speakerRef: true,
  parentTurnId: true,
  correlationRefs: true,
  addressedParticipantRefs: true,
  sourceRefs: true,
  effectReceiptRef: true,
  deliveryReceiptRefs: true,
}));

function rejectUnexpectedFields(
  value: Record<string, unknown>,
  allowedFields: Set<string>,
  label: string,
) {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new Error(`chat-conversation-owner-adapter-invalid:${label}.${field}:unexpected-field`);
    }
  }
}

function requireTurnConversation(turn: ChatAddressedExchangeTurnDraft, conversationId: string) {
  if (turn.conversationId !== conversationId) {
    throw new Error(`chat-conversation-owner-adapter-invalid:turn.${turn.turnId}.conversationId:mismatch`);
  }
}

function stableTurnValue(turn: ChatAddressedExchangeTurnDraft): string {
  return JSON.stringify({
    ...turn,
    correlationRefs: turn.correlationRefs ?? [],
    sourceRefs: turn.sourceRefs ?? [],
    addressedParticipantRefs: turn.addressedParticipantRefs ?? [],
    deliveryReceiptRefs: turn.deliveryReceiptRefs ?? [],
  });
}

export function canonicalChatMessagesToAddressedExchangeTurnDrafts(
  messages: readonly CanonicalChatMessageTurnSource[],
  conversationId: string,
  fallbackAssistantParticipantRef: string,
): ChatAddressedExchangeTurnDraft[] {
  if (fallbackAssistantParticipantRef.length === 0) {
    throw new Error('chat-conversation-owner-adapter-invalid:fallbackAssistantParticipantRef:nonempty-string-required');
  }

  return messages.map((message, index) => {
    const canonicalRole = message.canonicalRole ?? message.role;
    const speakerRef = message.speakerRef
      ?? (canonicalRole === 'human' ? 'addressed-participant:user' : undefined)
      ?? (canonicalRole ? fallbackAssistantParticipantRef : undefined);
    if (!speakerRef) {
      throw new Error(`chat-conversation-owner-adapter-invalid:turn.${message.id}.speakerRef:required`);
    }
    if (message.sequence !== undefined && (!Number.isSafeInteger(message.sequence) || message.sequence < 0)) {
      throw new Error(`chat-conversation-owner-adapter-invalid:turn.${message.id}.sequence:nonnegative-integer-required`);
    }
    return {
      turnId: message.id,
      conversationId,
      authorRef: message.authorRef ?? speakerRef,
      content: message.content,
      sequence: message.sequence ?? index,
      createdAt: message.timestamp,
      role: canonicalRole,
      speakerRef,
      parentTurnId: message.parentTurnRef,
      correlationRefs: message.correlationRefs,
      sourceRefs: message.sourceRefs,
      addressedParticipantRefs: message.addressedParticipantRefs,
      deliveryReceiptRefs: message.deliveryReceiptRefs,
      effectReceiptRef: message.effectReceiptRef,
    };
  });
}

export function mergeAddressedExchangeTurnDrafts(
  turns: readonly ChatAddressedExchangeTurnDraft[],
  conversationId: string,
): ChatAddressedExchangeTurnDraft[] {
  const turnsById = new Map<string, ChatAddressedExchangeTurnDraft>();
  for (const turn of turns) {
    requireTurnConversation(turn, conversationId);
    if (!Number.isSafeInteger(turn.sequence) || turn.sequence < 0) {
      throw new Error(`chat-conversation-owner-adapter-invalid:turn.${turn.turnId}.sequence:nonnegative-integer-required`);
    }
    const existing = turnsById.get(turn.turnId);
    if (existing && stableTurnValue(existing) !== stableTurnValue(turn)) {
      throw new Error(`chat-conversation-owner-adapter-invalid:turn.${turn.turnId}:conflicting-duplicate`);
    }
    turnsById.set(turn.turnId, turn);
  }

  const ordered = [...turnsById.values()].sort((left, right) => left.sequence - right.sequence);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].sequence <= ordered[index - 1].sequence) {
      throw new Error('chat-conversation-owner-adapter-invalid:sequence:strictly-increasing-required');
    }
  }
  return ordered;
}

function buildOwnerInputs(
  input: WriteAddressedExchangeThroughConversationsInput,
): {
  conversation: AddressedExchangeConversationInput;
  turns: AppendAddressedExchangeTurnsInput;
} {
  const conversationRecord = input.conversation as unknown as Record<string, unknown>;
  rejectUnexpectedFields(conversationRecord, CONVERSATION_FIELDS, 'conversation');
  if (!Array.isArray(input.turns) || input.turns.length === 0) {
    throw new Error('chat-conversation-owner-adapter-invalid:turns:nonempty-array-required');
  }

  const firstTurn = input.turns[0];
  const lastTurn = input.turns[input.turns.length - 1];
  const createdAt = input.conversation.createdAt ?? firstTurn.createdAt;
  const lastActivityAt = input.conversation.lastActivityAt ?? lastTurn.createdAt;
  const conversation: AddressedExchangeConversationInput = {
    conversation_ref: input.conversation.conversationId,
    participant_refs: input.conversation.participantRefs,
    way_refs: input.conversation.wayRefs,
    service_connection_refs: input.conversation.serviceConnectionRefs,
    title: input.conversation.title,
    last_message_preview: input.conversation.lastMessagePreview ?? lastTurn.content,
    last_activity_at: lastActivityAt,
    created_at: createdAt,
    updated_at: input.conversation.updatedAt ?? lastActivityAt,
    message_page_ref: input.conversation.messagePageRef ?? input.messagePageRef,
    cursor_ref: input.conversation.cursorRef,
    ...(input.conversation.projectSlug != null ? { project_slug: input.conversation.projectSlug } : {}),
    ...(input.conversation.projectName != null ? { project_name: input.conversation.projectName } : {}),
    proof_refs: input.conversation.proofRefs,
    blocker_refs: input.conversation.blockerRefs,
    handoff_refs: input.conversation.handoffRefs,
    route_refs: input.conversation.routeRefs,
    access_scope_ref: input.conversation.accessScopeRef,
    source_refs: input.conversation.sourceRefs,
    state_ref: input.conversation.stateRef,
    consent_state_ref: input.conversation.consentStateRef,
  };

  const turnRecords: AddressedExchangeTurnInput[] = input.turns.map((turn) => {
    rejectUnexpectedFields(turn as unknown as Record<string, unknown>, TURN_FIELDS, 'turn');
    return {
      turn_ref: turn.turnId,
      conversation_ref: turn.conversationId,
      role: turn.role,
      author_ref: turn.authorRef,
      speaker_ref: turn.speakerRef,
      content: turn.content,
      sequence: turn.sequence,
      occurred_at: turn.createdAt,
      parent_turn_ref: turn.parentTurnId,
      correlation_refs: turn.correlationRefs,
      addressed_participant_refs: turn.addressedParticipantRefs,
      source_refs: turn.sourceRefs,
      delivery_receipt_refs: turn.deliveryReceiptRefs,
      effect_receipt_ref: turn.effectReceiptRef,
    };
  });

  const turns: AppendAddressedExchangeTurnsInput = {
    turn_records: turnRecords,
    message_page_ref: input.messagePageRef,
    conversation_ref: input.conversation.conversationId,
    message_refs: turnRecords.map((turn) => turn.turn_ref),
    next_cursor_ref: input.nextCursorRef ?? lastTurn.turnId,
  };

  validateAddressedExchangeConversationInput(conversation);
  validateAppendAddressedExchangeTurnsInput(turns);
  return { conversation, turns };
}

export async function writeAddressedExchangeThroughConversations(
  input: WriteAddressedExchangeThroughConversationsInput,
  dispatch: ConversationOwnerActionDispatcher = dispatchConversationOwnerAction,
) {
  const ownerInputs = buildOwnerInputs(input);
  await upsertAddressedExchangeConversation(ownerInputs.conversation, dispatch);
  await appendAddressedExchangeTurns(ownerInputs.turns, dispatch);
  await publishAddressedExchangeProjections(dispatch);

  return {
    action_refs: [
      UPSERT_ADDRESSED_EXCHANGE_CONVERSATION_ACTION_ID,
      APPEND_ADDRESSED_EXCHANGE_TURNS_ACTION_ID,
      PUBLISH_ADDRESSED_EXCHANGE_PROJECTIONS_ACTION_ID,
    ],
    conversation_ref: ownerInputs.conversation.conversation_ref,
    turn_refs: ownerInputs.turns.turn_records.map((turn) => turn.turn_ref),
  };
}
