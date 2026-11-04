// PORTED FROM: bitfield-packages/packages/chat/read-data/map-conversation-projections-to-chat.ts @ e99ac5976
import type { AgentMessage } from './chat-message-types';
import type { ChatConversationRecord } from './read-chat-sessions';
import type {
  GenericMessagePageProjection,
  GenericRecordProjection,
  ProjectionMessage,
  ProjectionRecord,
} from '../../conversations/read-data/record-projection';

export interface ChatCanonicalAgentMessage extends AgentMessage {
  canonicalRole?: string;
  speakerRef?: string;
  authorRef?: string;
  addressedParticipantRefs?: string[];
  deliveryReceiptRefs?: string[];
  parentTurnRef?: string;
  correlationRefs?: string[];
  effectReceiptRef?: string;
  provenance?: Record<string, unknown>;
  sourceRefs?: string[];
  sequence?: number;
}

export interface ChatCanonicalConversationRecord extends ChatConversationRecord {
  canonicalPageRef?: string;
  accessScopeRef?: string;
  consentStateRef?: string;
  provenance?: Record<string, unknown>;
}

export interface ChatConversationProjectionMapping {
  sessions: ChatCanonicalConversationRecord[];
  messagesBySession: Record<string, ChatCanonicalAgentMessage[]>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function presentationRole(value: unknown): 'human' | 'assistant' | undefined {
  return value === 'human' || value === 'assistant' ? value : undefined;
}

function mapMessage(message: ProjectionMessage): ChatCanonicalAgentMessage {
  return {
    id: message.id,
    type: 'text',
    content: message.text,
    timestamp: message.occurredAt ?? '',
    role: presentationRole(message.role),
    canonicalRole: message.role,
    speakerRef: message.speakerRef,
    authorRef: message.authorRef,
    addressedParticipantRefs: message.addressedParticipantRefs,
    deliveryReceiptRefs: message.deliveryReceiptRefs,
    parentTurnRef: message.parentTurnRef,
    correlationRefs: message.correlationRefs,
    effectReceiptRef: message.effectReceiptRef,
    provenance: message.provenance,
    sourceRefs: message.sourceRefs,
    sequence: message.sequence,
    atomRef: message.recordRef,
    nativeRef: message.recordRef,
  };
}

function mapRecord(
  record: ProjectionRecord,
  messages: ProjectionMessage[],
): ChatCanonicalConversationRecord {
  const participantRefs = strings(record.relationships.participant_refs);
  const wayRefs = strings(record.relationships.way_refs);
  const serviceConnectionRefs = strings(
    record.fields.service_connection_refs ?? record.relationships.service_connection_refs,
  );
  const created = optionalString(record.fields.created_at) ?? record.sortKey ?? '';
  const lastActivity = optionalString(record.fields.last_activity_at) ?? record.sortKey ?? created;
  const lastMessage = messages[messages.length - 1];
  const actionableParticipantRefs = participantRefs.filter((ref) => ref !== 'addressed-participant:user');
  const provenanceSourceRefs = strings(
    record.fields.source_refs ?? record.provenance.source_refs,
  );
  const provenance = provenanceSourceRefs.length > 0
    ? { ...record.provenance, source_refs: provenanceSourceRefs }
    : record.provenance;

  return {
    recordId: record.recordRef,
    sessionId: record.recordRef,
    agentId: null,
    participantRefs,
    participantRef: actionableParticipantRefs[0] ?? participantRefs[0] ?? '',
    wayRefs,
    serviceConnectionRefs,
    legacySourceAdapterRef: '',
    model: null,
    slug: null,
    prompt: null,
    projectSlug: optionalString(record.fields.project_slug) ?? '',
    projectName: optionalString(record.fields.project_name) ?? null,
    canonicalPageRef: record.pageRef,
    accessScopeRef: optionalString(record.fields.access_scope_ref) ?? undefined,
    consentStateRef: optionalString(record.fields.consent_state_ref) ?? undefined,
    provenance,
    title: record.primaryText,
    startedAt: created,
    lastActivityAt: lastActivity,
    messageCount: messages.length,
    lastMessagePreview: record.secondaryText,
    lastMessageRole: lastMessage ? presentationRole(lastMessage.role) : null,
  };
}

export function mapConversationProjectionsToChat(
  recordList: GenericRecordProjection,
  messagePages: GenericMessagePageProjection,
): ChatConversationProjectionMapping {
  const messagesBySession: Record<string, ChatCanonicalAgentMessage[]> = {};
  const projectionMessagesBySession = new Map<string, ProjectionMessage[]>();

  for (const page of Object.values(messagePages.pages)) {
    const existing = projectionMessagesBySession.get(page.recordRef) ?? [];
    existing.push(...page.messages);
    projectionMessagesBySession.set(page.recordRef, existing);
  }

  for (const [sessionRef, messages] of projectionMessagesBySession) {
    const unique = new Map<string, ProjectionMessage>();
    for (const message of messages) {
      const prior = unique.get(message.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(message)) {
        throw new Error('chat-conversation-projection:conflicting-turn-replay');
      }
      unique.set(message.id, message);
    }
    const ordered = [...unique.values()].sort((left, right) => {
      const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
      const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
      if (leftSequence !== rightSequence) return leftSequence - rightSequence;
      return left.id.localeCompare(right.id);
    });
    projectionMessagesBySession.set(sessionRef, ordered);
  }

  const sessions = recordList.records.map((record) => {
    const messages = projectionMessagesBySession.get(record.recordRef) ?? [];
    messagesBySession[record.recordRef] = messages.map(mapMessage);
    return mapRecord(record, messages);
  });

  return { sessions, messagesBySession };
}
