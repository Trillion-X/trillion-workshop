// PORTED FROM: bitfield-packages/packages/conversations/read-data/record-projection.ts @ e99ac5976
export const CONVERSATION_RECORD_LIST_PROJECTION =
  'package::conversations::projection::record-list-v1';
export const CONVERSATION_MESSAGE_PAGE_PROJECTION =
  'package::conversations::projection::record-message-page-v1';
export const CONVERSATION_ACTION_SET_PROJECTION =
  'package::conversations::projection::record-action-set-v1';

export type ProjectionState = 'ready' | 'loading' | 'empty' | 'error';

export type JsonRecord = Record<string, unknown>;

export interface ProjectionFacet {
  key: string;
  label?: string;
  tone?: string;
  value?: unknown;
  refs?: string[];
}

export interface ProjectionActionDescriptor {
  id: string;
  label: string;
  target: string;
  operation?: string;
  definitionId?: string;
  input?: JsonRecord;
  inputMap?: Array<{ key: string; from?: string; value?: unknown; required?: boolean }>;
  disabledReason?: string;
  expectedResultProjection?: string;
  presentation?: JsonRecord;
  provenance?: JsonRecord;
}

export interface ProjectionRecord {
  recordRef: string;
  primaryText: string;
  secondaryText: string;
  sortKey: string;
  fields: JsonRecord;
  relationships: JsonRecord;
  facets: Record<string, ProjectionFacet | ProjectionFacet[] | unknown>;
  actionsRef?: string;
  pageRef?: string;
  provenance: JsonRecord;
}

export interface GenericRecordProjection {
  schema: 'generic.record_projection.v1';
  projectionId: string;
  generation: string;
  cursor: string;
  state: ProjectionState;
  records: ProjectionRecord[];
  actions: ProjectionActionDescriptor[];
  provenance: JsonRecord;
  error?: string;
}

export interface ProjectionMessage {
  id: string;
  recordRef: string;
  text: string;
  role?: string;
  speakerRef?: string;
  authorRef?: string;
  addressedParticipantRefs?: string[];
  deliveryReceiptRefs?: string[];
  parentTurnRef?: string;
  correlationRefs?: string[];
  effectReceiptRef?: string;
  sequence?: number;
  authorLabel?: string;
  occurredAt?: string;
  sourceRefs?: string[];
  facets: Record<string, ProjectionFacet | ProjectionFacet[] | unknown>;
  provenance: JsonRecord;
}

export interface GenericMessagePageProjection {
  schema: 'generic.record_message_page.v1';
  projectionId: string;
  generation: string;
  cursor: string;
  state: ProjectionState;
  pages: Record<string, {
    pageRef: string;
    recordRef: string;
    nextCursorRef?: string;
    messages: ProjectionMessage[];
    provenance: JsonRecord;
  }>;
  provenance: JsonRecord;
  error?: string;
}

function isObject(value: unknown): value is JsonRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function object(value: unknown): JsonRecord {
  return isObject(value) ? value : {};
}

function ref(value: unknown): string | undefined {
  return text(value) || undefined;
}

function refs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const validRefs = value.filter((entry): entry is string => {
    return typeof entry === 'string' && entry.length > 0;
  });
  return validRefs.length > 0 ? validRefs : undefined;
}

function state(value: unknown): ProjectionState {
  return value === 'loading' || value === 'empty' || value === 'error' ? value : 'ready';
}

function action(value: unknown): ProjectionActionDescriptor | null {
  if (!isObject(value)) return null;
  const id = text(value.id);
  const label = text(value.label, id);
  const target = text(value.target);
  const rawInputMap = value.input_map ?? value.inputMap;
  if (!id || !label || !target) return null;
  return {
    id,
    label,
    target,
    operation: text(value.operation) || undefined,
    definitionId: text(value.definition_id ?? value.definitionId) || undefined,
    input: object(value.input),
    inputMap: Array.isArray(rawInputMap)
      ? rawInputMap.filter(isObject).map((rule) => ({
          key: text(rule.key),
          from: text(rule.from) || undefined,
          value: rule.value,
          required: rule.required === true,
        })).filter((rule) => rule.key)
      : undefined,
    disabledReason: text(value.disabled_reason ?? value.disabledReason) || undefined,
    expectedResultProjection: text(
      value.expected_result_projection ?? value.expectedResultProjection,
    ) || undefined,
    presentation: object(value.presentation),
    provenance: object(value.provenance),
  };
}

function record(value: unknown, index: number): ProjectionRecord | null {
  if (!isObject(value)) return null;
  const recordRef = text(value.record_ref ?? value.recordRef);
  if (!recordRef) return null;
  return {
    recordRef,
    primaryText: text(value.primary_text ?? value.primaryText, recordRef),
    secondaryText: text(value.secondary_text ?? value.secondaryText),
    sortKey: text(value.sort_key ?? value.sortKey, `${index}`),
    fields: object(value.fields),
    relationships: object(value.relationships),
    facets: object(value.facets),
    actionsRef: text(value.actions_ref ?? value.actionsRef) || undefined,
    pageRef: text(value.page_ref ?? value.pageRef) || undefined,
    provenance: object(value.provenance),
  };
}

function message(value: unknown, index: number): ProjectionMessage | null {
  if (!isObject(value)) return null;
  const recordRef = text(value.record_ref ?? value.recordRef);
  const textValue = text(value.text ?? value.body ?? value.content);
  if (!recordRef || !textValue) return null;
  return {
    id: text(value.id, `${recordRef}:message:${index}`),
    recordRef,
    text: textValue,
    role: ref(value.role),
    speakerRef: ref(value.speaker_ref ?? value.speakerRef),
    authorRef: ref(value.author_ref ?? value.authorRef ?? object(value.provenance).author_ref),
    addressedParticipantRefs: refs(value.addressed_participant_refs ?? value.addressedParticipantRefs),
    deliveryReceiptRefs: refs(value.delivery_receipt_refs ?? value.deliveryReceiptRefs),
    parentTurnRef: ref(value.parent_turn_ref ?? value.parentTurnRef),
    correlationRefs: refs(value.correlation_refs ?? value.correlationRefs),
    effectReceiptRef: ref(value.effect_receipt_ref ?? value.effectReceiptRef),
    sequence: typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence)
      ? value.sequence
      : undefined,
    authorLabel: text(value.author_label ?? value.authorLabel) || undefined,
    occurredAt: text(value.occurred_at ?? value.occurredAt) || undefined,
    sourceRefs: refs(
      value.source_refs
        ?? value.sourceRefs
        ?? object(value.provenance).source_refs
        ?? object(value.provenance).sourceRefs,
    ),
    facets: object(value.facets),
    provenance: object(value.provenance),
  };
}

export function decodeGenericRecordProjection(raw: unknown): GenericRecordProjection {
  const payload = isObject(raw) ? raw : {};
  const records = Array.isArray(payload.records) ? payload.records : [];
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  return {
    schema: 'generic.record_projection.v1',
    projectionId: text(payload.projection_id ?? payload.projectionId),
    generation: text(payload.generation),
    cursor: text(payload.cursor),
    state: state(payload.state),
    records: records.map(record).filter((entry): entry is ProjectionRecord => entry !== null),
    actions: actions.map(action).filter((entry): entry is ProjectionActionDescriptor => entry !== null),
    provenance: object(payload.provenance),
    error: text(payload.error) || undefined,
  };
}

export function decodeGenericMessagePageProjection(raw: unknown): GenericMessagePageProjection {
  const payload = isObject(raw) ? raw : {};
  const rawPages = object(payload.pages);
  const pages: GenericMessagePageProjection['pages'] = {};
  for (const [pageRef, rawPage] of Object.entries(rawPages)) {
    if (!isObject(rawPage)) continue;
    const messages = Array.isArray(rawPage.messages) ? rawPage.messages : [];
    const normalizedPageRef = text(rawPage.page_ref ?? rawPage.pageRef, pageRef);
    const recordRef = text(rawPage.record_ref ?? rawPage.recordRef);
    if (!normalizedPageRef || !recordRef) continue;
    pages[normalizedPageRef] = {
      pageRef: normalizedPageRef,
      recordRef,
      nextCursorRef: ref(rawPage.next_cursor_ref ?? rawPage.nextCursorRef),
      messages: messages
        .map(message)
        .filter((entry): entry is ProjectionMessage => entry !== null),
      provenance: object(rawPage.provenance),
    };
  }
  return {
    schema: 'generic.record_message_page.v1',
    projectionId: text(payload.projection_id ?? payload.projectionId),
    generation: text(payload.generation),
    cursor: text(payload.cursor),
    state: state(payload.state),
    pages,
    provenance: object(payload.provenance),
    error: text(payload.error) || undefined,
  };
}
