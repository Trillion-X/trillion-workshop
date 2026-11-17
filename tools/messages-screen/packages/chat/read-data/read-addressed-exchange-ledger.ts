import type { AgentMessage, MessagePerformControl } from './chat-message-types';
import {
  decodeAddressedExchangeEvent as decodeOwnerAddressedExchangeEvent,
  type AddressedExchangeEvent,
} from './read-addressed-exchange';

export type { AddressedExchangeEvent };

export type AddressedExchangeTurnRole = string;

export interface AddressedExchangeExecutionReceipt {
  participantRef: string;
  participantRefs?: string[];
  routeRef?: string | null;
  resultRef?: string | null;
  eventFeedRef?: string | null;
  resultProjectionRef?: string | null;
  streamParseSpecRef?: string | null;
  modelRef: string | null;
  accountRef: string | null;
  sourceSessionRef: string | null;
  sourcePath: string | null;
  processSessionRef: string | null;
  processSessionEventsAddress: string | null;
  state: string;
}

export interface AddressedExchangeTurn {
  turnId: string;
  conversationId: string;
  parentTurnId: string | null;
  sequence: number;
  role: AddressedExchangeTurnRole;
  speakerRef: string | null;
  addressedParticipantRefs?: string[];
  sourceRefs: string[];
  correlationRefs: string[];
  content: string;
  createdAt: string;
  executionReceipt: AddressedExchangeExecutionReceipt | null;
  controls?: MessagePerformControl[];
}

export interface AddressedExchangeConversation {
  conversationId: string;
  title: string | null;
  projectSlug: string | null;
  projectLabel: string | null;
  createdAt: string;
  updatedAt: string;
  turnIds: string[];
}

export interface AddressedExchangeLedger {
  conversation: AddressedExchangeConversation;
  turns: AddressedExchangeTurn[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

export function decodeMessagePerformControls(value: unknown): MessagePerformControl[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.perform)) return [];
    const id = stringValue(entry.id);
    const label = stringValue(entry.label);
    const capabilityRef = isRecord(entry.perform.capabilityRef) ? entry.perform.capabilityRef : null;
    const canonicalAddress = capabilityRef ? stringValue(capabilityRef.canonicalAddress) : null;
    const canonicalRevision = capabilityRef ? stringValue(capabilityRef.canonicalRevision) : null;
    const payloadHash = capabilityRef ? stringValue(capabilityRef.payloadHash) : null;
    if (!id || !label || !canonicalAddress || !canonicalRevision || !payloadHash) return [];
    return [{
      id,
      label,
      ...(stringValue(entry.pendingLabel) ? { pendingLabel: stringValue(entry.pendingLabel)! } : {}),
      ...(stringValue(entry.successLabel) ? { successLabel: stringValue(entry.successLabel)! } : {}),
      perform: {
        capabilityRef: { canonicalAddress, canonicalRevision, payloadHash },
        input: entry.perform.input,
        proofRefs: stringArray(entry.perform.proofRefs),
      },
    }];
  });
}

export function decodeAddressedExchangeExecutionReceipt(value: unknown): AddressedExchangeExecutionReceipt | null {
  if (!isRecord(value)) return null;
  const participantRef = stringValue(value.participantRef);
  if (!participantRef) return null;
  return {
    participantRef,
    participantRefs: stringArray(value.participantRefs ?? value.participant_refs),
    routeRef: stringValue(value.routeRef) ?? stringValue(value.route_ref),
    resultRef: stringValue(value.resultRef) ?? stringValue(value.result_ref),
    eventFeedRef: stringValue(value.eventFeedRef) ?? stringValue(value.event_feed_ref),
    resultProjectionRef: stringValue(value.resultProjectionRef) ?? stringValue(value.result_projection_ref),
    streamParseSpecRef: stringValue(value.streamParseSpecRef) ?? stringValue(value.stream_parse_spec_ref),
    modelRef: stringValue(value.modelRef) ?? stringValue(value.model),
    accountRef: stringValue(value.accountRef) ?? stringValue(value.accountDir),
    sourceSessionRef: stringValue(value.sourceSessionRef),
    sourcePath: stringValue(value.sourcePath),
    processSessionRef: stringValue(value.processSessionRef) ?? stringValue(value.processSessionId),
    processSessionEventsAddress: stringValue(value.processSessionEventsAddress),
    state: stringValue(value.state) ?? 'requested',
  };
}

export function decodeAddressedExchangeTurn(value: unknown): AddressedExchangeTurn | null {
  if (!isRecord(value)) return null;
  const turnId = stringValue(value.turnId);
  const conversationId = stringValue(value.conversationId);
  const role = stringValue(value.role);
  const content = typeof value.content === 'string' ? value.content : null;
  const createdAt = stringValue(value.createdAt);
  const sequence = numberValue(value.sequence);
  if (!turnId || !conversationId || content === null || !createdAt || sequence === null || !role) return null;
  return {
    turnId,
    conversationId,
    parentTurnId: stringValue(value.parentTurnId),
    sequence,
    role,
    speakerRef: stringValue(value.speakerRef) ?? stringValue(value.participantRef) ?? stringValue(value.participant_ref),
    addressedParticipantRefs: stringArray(
      value.addressedParticipantRefs ?? value.addressed_participant_refs,
    ),
    sourceRefs: stringArray(value.sourceRefs ?? value.source_refs),
    correlationRefs: stringArray(value.correlationRefs ?? value.correlation_refs),
    content,
    createdAt,
    executionReceipt: decodeAddressedExchangeExecutionReceipt(value.executionReceipt ?? value.providerReceipt),
    controls: decodeMessagePerformControls(value.controls),
  };
}

export function decodeAddressedExchangeEvent(value: unknown): AddressedExchangeEvent | null {
  const ownerEvent = decodeOwnerAddressedExchangeEvent(value);
  if (ownerEvent) return ownerEvent;

  const turn = decodeAddressedExchangeTurn(value);
  if (!turn) return null;
  const receiptRefs = [
    turn.executionReceipt?.sourceSessionRef,
    turn.executionReceipt?.processSessionRef,
    turn.executionReceipt?.processSessionEventsAddress,
  ].filter((ref): ref is string => Boolean(ref));
  return {
    eventRef: turn.turnId,
    exchangeScopeRef: turn.conversationId,
    participantRef: turn.speakerRef,
    sourceRefs: turn.sourceRefs,
    correlationRefs: turn.correlationRefs.length > 0 ? turn.correlationRefs : [turn.turnId],
    payload: {
      role: turn.role,
      content: turn.content,
    },
    createdAt: turn.createdAt,
    evidenceRefs: receiptRefs,
  };
}

export function decodeAddressedExchangeConversation(value: unknown): AddressedExchangeConversation | null {
  if (!isRecord(value)) return null;
  const conversationId = stringValue(value.conversationId);
  const createdAt = stringValue(value.createdAt);
  const updatedAt = stringValue(value.updatedAt);
  if (!conversationId || !createdAt || !updatedAt) return null;
  return {
    conversationId,
    title: stringValue(value.title),
    projectSlug: stringValue(value.projectSlug),
    projectLabel: stringValue(value.projectLabel),
    createdAt,
    updatedAt,
    turnIds: stringArray(value.turnIds),
  };
}

export function addressedExchangeTurnsToAgentMessages(turns: readonly AddressedExchangeTurn[]): AgentMessage[] {
  return turns
    .filter((turn) => turn.role === 'human' || turn.role === 'assistant')
    .sort((left, right) => left.sequence - right.sequence)
    .map((turn) => ({
      id: turn.turnId,
      type: 'text',
      role: turn.role === 'human' ? 'human' : 'assistant',
      content: turn.content,
      timestamp: turn.createdAt,
      ...(turn.controls && turn.controls.length > 0 ? { performControls: turn.controls } : {}),
    }));
}
