import type { AddressedContextGrant, AddressedExchangeEvent } from './read-addressed-exchange';
import type { AddressedParticipantInfo } from './read-addressed-exchange-participants';
import type { ChatWorkflowAction } from './read-chat-work-actions';
import { decodeAddressedExchangeEvent } from './read-addressed-exchange-ledger';

export interface AddressedExchangeRecord {
  exchangeRef: string;
  label: string | null;
  fields: Record<string, unknown>;
  participantRefs: string[];
  stateRefs: string[];
  relationshipRefs: string[];
  evidenceRefs: string[];
}

export interface AddressedExchangeReceipt {
  receiptRef: string;
  ownerTargetRef: string | null;
  statusRef: string | null;
  actionRef: string | null;
  eventRef: string | null;
  processSessionRef: string | null;
  workflowRef: string | null;
  evidenceRefs: string[];
  payload: unknown;
}

export interface AddressedExchangeProjectionMetadata {
  status: 'empty' | 'sparse' | 'dense';
  eventCount: number;
  recordCount: number;
  actionCount: number;
  participantCount: number;
}

export interface AddressedExchangeWorkspace {
  records: AddressedExchangeRecord[];
  fields: Record<string, unknown>;
  events: AddressedExchangeEvent[];
  participants: AddressedParticipantInfo[];
  actionCatalog: ChatWorkflowAction[];
  contextGrants: AddressedContextGrant[];
  receipts: AddressedExchangeReceipt[];
  evidenceRefs: string[];
  projection: AddressedExchangeProjectionMetadata;
}

export interface AddressedExchangeWorkspaceInput {
  records?: readonly unknown[];
  events?: readonly unknown[];
  participants?: readonly AddressedParticipantInfo[];
  actionCatalog?: readonly ChatWorkflowAction[];
  contextGrants?: readonly AddressedContextGrant[];
  receipts?: readonly unknown[];
  fields?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function decodeAddressedExchangeRecord(value: unknown): AddressedExchangeRecord | null {
  if (!isRecord(value)) return null;
  const exchangeRef =
    stringValue(value.exchangeRef)
    ?? stringValue(value.exchange_ref)
    ?? stringValue(value.id)
    ?? stringValue(value.recordId);
  if (!exchangeRef) return null;
  return {
    exchangeRef,
    label: stringValue(value.label) ?? stringValue(value.title) ?? null,
    fields: objectValue(value.fields),
    participantRefs: stringArray(value.participantRefs ?? value.participant_refs),
    stateRefs: stringArray(value.stateRefs ?? value.state_refs),
    relationshipRefs: stringArray(value.relationshipRefs ?? value.relationship_refs),
    evidenceRefs: stringArray(value.evidenceRefs ?? value.evidence_refs),
  };
}

export function decodeAddressedExchangeReceipt(value: unknown): AddressedExchangeReceipt | null {
  if (!isRecord(value)) return null;
  const receiptRef =
    stringValue(value.receiptRef)
    ?? stringValue(value.receipt_ref)
    ?? stringValue(value.id);
  if (!receiptRef) return null;
  return {
    receiptRef,
    ownerTargetRef: stringValue(value.ownerTargetRef) ?? stringValue(value.owner_target_ref),
    statusRef: stringValue(value.statusRef) ?? stringValue(value.status_ref),
    actionRef: stringValue(value.actionRef) ?? stringValue(value.action_ref),
    eventRef: stringValue(value.eventRef) ?? stringValue(value.event_ref),
    processSessionRef: stringValue(value.processSessionRef) ?? stringValue(value.process_session_ref),
    workflowRef: stringValue(value.workflowRef) ?? stringValue(value.workflow_ref),
    evidenceRefs: stringArray(value.evidenceRefs ?? value.evidence_refs),
    payload: value.payload ?? null,
  };
}

function projectionStatus(eventCount: number): AddressedExchangeProjectionMetadata['status'] {
  if (eventCount === 0) return 'empty';
  return eventCount > 24 ? 'dense' : 'sparse';
}

export function readAddressedExchangeWorkspace(input: AddressedExchangeWorkspaceInput): AddressedExchangeWorkspace {
  const records = (input.records ?? [])
    .map(decodeAddressedExchangeRecord)
    .filter((record): record is AddressedExchangeRecord => record !== null);
  const events = (input.events ?? [])
    .map(decodeAddressedExchangeEvent)
    .filter((event): event is AddressedExchangeEvent => event !== null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.eventRef.localeCompare(right.eventRef));
  const receipts = (input.receipts ?? [])
    .map(decodeAddressedExchangeReceipt)
    .filter((receipt): receipt is AddressedExchangeReceipt => receipt !== null);
  const evidenceRefs = Array.from(new Set([
    ...records.flatMap((record) => record.evidenceRefs),
    ...events.flatMap((event) => event.evidenceRefs),
    ...receipts.flatMap((receipt) => receipt.evidenceRefs),
    ...(input.contextGrants?.flatMap((grant) => grant.evidenceRefs) ?? []),
  ]));
  return {
    records,
    fields: input.fields ?? {},
    events,
    participants: [...(input.participants ?? [])],
    actionCatalog: [...(input.actionCatalog ?? [])],
    contextGrants: [...(input.contextGrants ?? [])],
    receipts,
    evidenceRefs,
    projection: {
      status: projectionStatus(events.length),
      eventCount: events.length,
      recordCount: records.length,
      actionCount: input.actionCatalog?.length ?? 0,
      participantCount: input.participants?.length ?? 0,
    },
  };
}
