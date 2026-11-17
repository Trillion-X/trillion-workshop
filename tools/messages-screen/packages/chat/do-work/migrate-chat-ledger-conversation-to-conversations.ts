import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { buildConversationProjections } from '../../../../conversations/read-data/build-conversation-projections';
import {
  type ConversationMessagePageProjection,
} from '../../conversations/read-data/read-conversation-messages';
import {
  type ConversationRecordListProjection,
} from '../../conversations/read-data/read-conversations';
import {
  readAddressedExchangeLedger,
  type AddressedExchangeLedger,
} from './write-addressed-exchange-ledger';
import {
  writeAddressedExchangeThroughConversations,
  type WriteAddressedExchangeThroughConversationsInput,
} from './write-addressed-exchange-through-conversations';

const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_READ_CURRENT_OPERATION = 'engine.operation.read-current';
const DEFAULT_CHAT_WAY_REF = 'way:chat:current-surface';
const CANONICAL_OWNER_FEED_LABELS = [
  'conversations.addressed-exchange-conversations',
  'conversations.addressed-exchange-turns',
  'conversations.addressed-exchange-message-pages',
] as const;

export interface ChatLedgerConversationMigrationInput {
  conversationId: string;
  /** Explicit opaque receipt refs for legacy inlined execution objects. */
  effectReceiptRefs?: Record<string, string>;
  wayRefs?: string[];
}

export interface ChatLedgerMigrationDraft {
  canonical: WriteAddressedExchangeThroughConversationsInput;
  before: {
    conversationId: string;
    title: string | null;
    turnIds: string[];
    turnCount: number;
  };
}

export interface ChatLedgerMigrationProof {
  status: 'migrated' | 'already_migrated';
  conversationId: string;
  beforeTurnCount: number;
  afterTurnCount: number;
  orderedTurnIds: string[];
  checks: {
    identityPreserved: boolean;
    countPreserved: boolean;
    orderPreserved: boolean;
    contentPreserved: boolean;
    titlePreserved: boolean;
    timestampsPreserved: boolean;
    speakersPreserved: boolean;
    lineagePreserved: boolean;
    correlationsPreserved: boolean;
    effectReceiptsPreserved: boolean;
    participantsPreserved: boolean;
    projectMetadataPreserved: boolean;
  };
}

interface TargetReplyEnvelope {
  payload?: Uint8Array;
}

export interface ChatLedgerMigrationDependencies {
  readLegacyConversation?: (conversationId: string) => Promise<AddressedExchangeLedger | null>;
  writeCanonicalConversation?: (
    input: WriteAddressedExchangeThroughConversationsInput,
  ) => Promise<unknown>;
  readCanonicalProjection?: (
    conversationId: string,
  ) => Promise<{
    recordList: ConversationRecordListProjection;
    messagePages: ConversationMessagePageProjection;
  }>;
}

async function readProjectionPayload(addressLabel: string): Promise<unknown> {
  const reply = await sendRequestToBitfieldTarget({
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_READ_CURRENT_OPERATION,
      address_label: addressLabel,
    },
  }) as TargetReplyEnvelope;
  const payload = reply.payload;
  if (!(payload instanceof Uint8Array)) return null;
  return JSON.parse(new TextDecoder().decode(payload)) as unknown;
}

async function readCanonicalProjection(conversationId: string) {
  void conversationId;
  const [conversations, turns, messagePages] = await Promise.all(
    CANONICAL_OWNER_FEED_LABELS.map((addressLabel) => readProjectionPayload(addressLabel)),
  );
  return buildConversationProjections(conversations, turns, messagePages);
}

function requireNonemptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`chat-ledger-migration-invalid:${field}:nonempty-string-required`);
  }
  return value;
}

function orderedLegacyTurns(ledger: AddressedExchangeLedger) {
  return [...ledger.turns].sort((left, right) => left.sequence - right.sequence);
}

function buildParticipants(ledger: AddressedExchangeLedger): string[] {
  const participants: string[] = [];
  for (const turn of orderedLegacyTurns(ledger)) {
    const speakerRef = requireNonemptyString(turn.speakerRef, `turn.${turn.turnId}.speakerRef`);
    if (!participants.includes(speakerRef)) participants.push(speakerRef);
    for (const addressedParticipantRef of turn.addressedParticipantRefs ?? []) {
      const participantRef = requireNonemptyString(
        addressedParticipantRef,
        `turn.${turn.turnId}.addressedParticipantRefs`,
      );
      if (!participants.includes(participantRef)) participants.push(participantRef);
    }
  }
  if (participants.length === 0) {
    throw new Error('chat-ledger-migration-invalid:participant_refs:nonempty-array-required');
  }
  return participants;
}

export function buildChatLedgerMigrationDraft(
  input: ChatLedgerConversationMigrationInput,
  ledger: AddressedExchangeLedger,
): ChatLedgerMigrationDraft {
  requireNonemptyString(input.conversationId, 'conversationId');
  if (ledger.conversation.conversationId !== input.conversationId) {
    throw new Error('chat-ledger-migration-invalid:conversationId:mismatch');
  }

  const turns = orderedLegacyTurns(ledger);
  const orderedTurnIds = turns.map((turn) => turn.turnId);
  if (orderedTurnIds.some((turnId, index) => ledger.conversation.turnIds[index] !== turnId)) {
    throw new Error('chat-ledger-migration-invalid:turnIds:sequence-order-mismatch');
  }
  if (new Set(orderedTurnIds).size !== orderedTurnIds.length) {
    throw new Error('chat-ledger-migration-invalid:turnIds:duplicate-turn');
  }
  if (turns.some((turn, index) => index > 0 && turn.sequence <= turns[index - 1].sequence)) {
    throw new Error('chat-ledger-migration-invalid:sequence:strictly-increasing-required');
  }

  const participants = buildParticipants(ledger);
  const messagePageRef = `message-page:${input.conversationId}`;
  const canonicalTurns = turns.map((turn) => {
    if (turn.controls && turn.controls.length > 0) {
      throw new Error(`chat-ledger-migration-invalid:turn.${turn.turnId}.controls:explicit-mapping-required`);
    }
    const speakerRef = requireNonemptyString(turn.speakerRef, `turn.${turn.turnId}.speakerRef`);
    const effectReceiptRef = turn.executionReceipt
      ? requireNonemptyString(
        input.effectReceiptRefs?.[turn.turnId],
        `effectReceiptRefs.${turn.turnId}`,
      )
      : undefined;
    return {
      turnId: turn.turnId,
      conversationId: input.conversationId,
      authorRef: speakerRef,
      content: turn.content,
      sequence: turn.sequence,
      createdAt: turn.createdAt,
      role: turn.role,
      speakerRef,
      parentTurnId: turn.parentTurnId ?? undefined,
      correlationRefs: turn.correlationRefs,
      sourceRefs: turn.sourceRefs,
      effectReceiptRef,
    };
  });

  const lastTurn = turns[turns.length - 1];
  const canonical = {
    conversation: {
      conversationId: input.conversationId,
      participantRefs: participants,
      wayRefs: input.wayRefs ?? [DEFAULT_CHAT_WAY_REF],
      serviceConnectionRefs: [],
      title: ledger.conversation.title ?? input.conversationId,
      lastMessagePreview: lastTurn.content,
      lastActivityAt: ledger.conversation.updatedAt,
      createdAt: ledger.conversation.createdAt,
      updatedAt: ledger.conversation.updatedAt,
      messagePageRef,
      cursorRef: lastTurn.turnId,
      projectSlug: ledger.conversation.projectSlug ?? undefined,
      projectName: ledger.conversation.projectLabel ?? undefined,
      sourceRefs: [],
    },
    turns: canonicalTurns,
    messagePageRef,
    nextCursorRef: lastTurn.turnId,
  };

  return {
    canonical,
    before: {
      conversationId: ledger.conversation.conversationId,
      title: ledger.conversation.title,
      turnIds: orderedTurnIds,
      turnCount: orderedTurnIds.length,
    },
  };
}

function canonicalMessagesForConversation(
  projection: {
    recordList: ConversationRecordListProjection;
    messagePages: ConversationMessagePageProjection;
  },
  conversationId: string,
) {
  return Object.values(projection.messagePages.pages)
    .filter((page) => page.recordRef === conversationId)
    .flatMap((page) => page.messages)
    .sort((left, right) => (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER));
}

export function verifyChatLedgerMigrationProof(
  draft: ChatLedgerMigrationDraft,
  projection: {
    recordList: ConversationRecordListProjection;
    messagePages: ConversationMessagePageProjection;
  },
): ChatLedgerMigrationProof {
  const conversationId = draft.before.conversationId;
  const record = projection.recordList.records.find((entry) => entry.recordRef === conversationId);
  const messages = canonicalMessagesForConversation(projection, conversationId);
  const orderedTurnIds = draft.before.turnIds;
  const afterTurnIds = messages.map((message) => message.id);
  const legacyById = new Map(draft.canonical.turns.map((turn) => [turn.turnId, turn]));

  const checks = {
    identityPreserved: record !== undefined,
    countPreserved: afterTurnIds.length === orderedTurnIds.length,
    orderPreserved: afterTurnIds.every((turnId, index) => turnId === orderedTurnIds[index]),
    contentPreserved: messages.every((message) => message.text === legacyById.get(message.id)?.content),
    titlePreserved: record?.primaryText === draft.canonical.conversation.title,
    timestampsPreserved: messages.every((message) => {
      const legacy = legacyById.get(message.id);
      return message.occurredAt === legacy?.createdAt;
    }),
    speakersPreserved: messages.every((message) => {
      const legacy = legacyById.get(message.id);
      return message.speakerRef === legacy?.speakerRef;
    }),
    lineagePreserved: messages.every((message) => {
      const legacy = legacyById.get(message.id);
      return (message.parentTurnRef ?? undefined) === (legacy?.parentTurnId ?? undefined);
    }),
    correlationsPreserved: messages.every((message) => {
      const legacy = legacyById.get(message.id);
      return JSON.stringify(message.correlationRefs ?? []) ===
        JSON.stringify(legacy?.correlationRefs ?? []);
    }),
    effectReceiptsPreserved: messages.every((message) => {
      const legacy = legacyById.get(message.id);
      return (message.effectReceiptRef ?? undefined) === (legacy?.effectReceiptRef ?? undefined);
    }),
    participantsPreserved: record !== undefined &&
      JSON.stringify(record.relationships.participant_refs ?? []) ===
        JSON.stringify(draft.canonical.conversation.participantRefs),
    projectMetadataPreserved: record !== undefined &&
      (record.fields.project_slug ?? undefined) === (draft.canonical.conversation.projectSlug ?? undefined) &&
      (record.fields.project_name ?? undefined) === (draft.canonical.conversation.projectName ?? undefined),
  };

  const ok = Object.values(checks).every(Boolean);
  if (!ok) {
    throw new Error(`chat-ledger-migration-proof-failed:${Object.keys(checks).filter((key) => !checks[key as keyof typeof checks]).join(',')}`);
  }

  return {
    status: 'migrated',
    conversationId,
    beforeTurnCount: orderedTurnIds.length,
    afterTurnCount: afterTurnIds.length,
    orderedTurnIds,
    checks,
  };
}

function alreadyMigrated(
  draft: ChatLedgerMigrationDraft,
  proof: ChatLedgerMigrationProof,
): ChatLedgerMigrationProof {
  return { ...proof, status: 'already_migrated' };
}

export async function migrateChatLedgerConversationToConversations(
  input: ChatLedgerConversationMigrationInput,
  dependencies: ChatLedgerMigrationDependencies = {},
): Promise<ChatLedgerMigrationProof> {
  const readLegacyConversation = dependencies.readLegacyConversation ?? readAddressedExchangeLedger;
  const writeCanonicalConversation = dependencies.writeCanonicalConversation ??
    writeAddressedExchangeThroughConversations;
  const readCanonicalProjectionDependency = dependencies.readCanonicalProjection ??
    readCanonicalProjection;

  const ledger = await readLegacyConversation(input.conversationId);
  if (!ledger) throw new Error('chat-ledger-migration-invalid:conversation:not-found');
  const draft = buildChatLedgerMigrationDraft(input, ledger);

  const beforeProjection = await readCanonicalProjectionDependency(input.conversationId);
  const record = beforeProjection.recordList.records.find(
    (entry) => entry.recordRef === input.conversationId,
  );
  if (record) {
    try {
      return alreadyMigrated(draft, verifyChatLedgerMigrationProof(draft, beforeProjection));
    } catch {
      // A partial or conflicting canonical row is repaired by the explicit write below,
      // then fails closed unless the resulting projection is exact.
    }
  }

  await writeCanonicalConversation(draft.canonical);
  const afterProjection = await readCanonicalProjectionDependency(input.conversationId);
  return verifyChatLedgerMigrationProof(draft, afterProjection);
}
