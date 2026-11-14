export type JsonRecord = Record<string, unknown>;

export interface PublishedRecordRow {
  address?: string;
  payload?: unknown;
}

export interface CoordinationFieldDescriptor {
  id: string;
  label: string;
  valueShape: string;
  order: number;
  domain?: unknown[];
}

export interface CoordinationViewDescriptor {
  id: string;
  label: string;
  order: number;
  groupBy?: string;
  orderBy?: string;
  filter?: unknown;
  /**
   * Generic arrangement discriminant (DATA, mirrors visual-database's `view.kind`):
   * how the collection lays this view out — `list`, `table`, `board`, … The
   * collection dispatches on it through an OPEN map with a `list` fallback, so a
   * new arrangement is a data value + one renderer entry, never a panel edit.
   * Absent → the collection's default arrangement.
   */
  arrangement?: string;
}

export interface CoordinationActionDescriptor {
  id: string;
  label: string;
  order: number;
  targetRef?: string;
  operation?: string;
  definitionRef?: string;
  inputMap?: unknown;
  receiptRef?: string;
  availability?: unknown;
}

export interface CoordinationRelationshipRef {
  role: string;
  targetRef: string;
  ownerRef?: string;
  metadata?: JsonRecord;
}

export interface CoordinationEvidenceRef {
  role: string;
  ownerRef: string;
  summaryRef?: string;
  status?: string;
}

export interface CoordinationProcessSessionRef {
  sessionRef: string;
  eventFeedRef?: string;
  terminalStateRef?: string;
}

export interface CoordinationRecoverableIssue {
  /** Stable identity for keying/selection. */
  id: string;
  /** The record this issue is about, when scoped to one (raw ref). */
  recordRef?: string;
  /** Severity as authored (raw — the show layer maps it to a SeverityRow level). */
  severity: string;
  /** Human-ready message (already user-facing copy in the data). */
  message: string;
  /** Action descriptor id to re-run the failed work, bound by the banner's retry. */
  retryActionRef?: string;
  raw: JsonRecord;
}

export interface CoordinationRecord {
  id: string;
  label: string;
  fieldValues: JsonRecord;
  relationships: CoordinationRelationshipRef[];
  ruleResults: JsonRecord[];
  viewMemberships: JsonRecord[];
  actionDescriptorIds: string[];
  workflowRefs: JsonRecord[];
  processSessionRefs: CoordinationProcessSessionRef[];
  evidenceRefs: CoordinationEvidenceRef[];
  raw: JsonRecord;
}

export interface CoordinationSurfaceModel {
  records: CoordinationRecord[];
  fields: CoordinationFieldDescriptor[];
  views: CoordinationViewDescriptor[];
  actions: CoordinationActionDescriptor[];
  relationships: CoordinationRelationshipRef[];
  evidence: CoordinationEvidenceRef[];
  processSessions: CoordinationProcessSessionRef[];
  recoverableIssues: CoordinationRecoverableIssue[];
  surfaceCopy: {
    title: string;
    emptyText: string;
    emptyActionLabel: string;
    runningText: string;
    defaultViewLabel: string;
  };
  freshness: { source: string; recordCount: number };
}

export interface CoordinationInput {
  records?: PublishedRecordRow[];
  coordinationRecords?: unknown[];
  fields?: unknown[];
  views?: unknown[];
  actions?: unknown[];
  relationships?: unknown[];
  evidence?: unknown[];
  processSessions?: unknown[];
  recoverableIssues?: unknown[];
  surfaceCopy?: unknown;
  freshnessSource?: string;
}

export const COORDINATION_KINDS = {
  record: 'coordination.record.v1',
  field: 'coordination.field.v1',
  view: 'coordination.view.v1',
  action: 'coordination.action.v1',
  relationship: 'coordination.relationship.v1',
  evidence: 'coordination.evidence.v1',
  processSession: 'coordination.process-session-ref.v1',
  recoverableIssue: 'coordination.recoverable-issue.v1',
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function objects(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function payloads(rows: PublishedRecordRow[] | undefined, kind: string): JsonRecord[] {
  return (rows ?? [])
    .map((row) => row.payload)
    .filter((payload): payload is JsonRecord => isRecord(payload) && payload.kind === kind);
}

function mergeByKind(input: CoordinationInput, explicit: unknown[] | undefined, kind: string): JsonRecord[] {
  return [
    ...objects(explicit),
    ...payloads(input.records, kind),
  ];
}

function relationship(value: JsonRecord): CoordinationRelationshipRef {
  return {
    role: text(value.role, 'related'),
    targetRef: text(value.target_ref ?? value.targetRef, ''),
    ownerRef: text(value.owner_ref ?? value.ownerRef, '') || undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

function evidence(value: JsonRecord): CoordinationEvidenceRef {
  return {
    role: text(value.role, 'evidence'),
    ownerRef: text(value.owner_ref ?? value.ownerRef, ''),
    summaryRef: text(value.summary_ref ?? value.summaryRef, '') || undefined,
    status: text(value.status, '') || undefined,
  };
}

function processSession(value: JsonRecord): CoordinationProcessSessionRef {
  return {
    sessionRef: text(value.session_ref ?? value.sessionRef, ''),
    eventFeedRef: text(value.event_feed_ref ?? value.eventFeedRef, '') || undefined,
    terminalStateRef: text(value.terminal_state_ref ?? value.terminalStateRef, '') || undefined,
  };
}

function recoverableIssue(value: JsonRecord, index: number): CoordinationRecoverableIssue {
  let message = '';
  for (const key of ['message', 'summary', 'detail', 'text']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      message = candidate;
      break;
    }
  }
  return {
    id: text(value.id ?? value.issue_ref ?? value.issueRef, `issue:${index}`),
    recordRef: text(value.record_ref ?? value.recordRef, '') || undefined,
    severity: text(value.severity, 'warning'),
    message: message || 'Something needs attention.',
    retryActionRef: text(value.retry_action_ref ?? value.retryActionRef, '') || undefined,
    raw: value,
  };
}

function field(value: JsonRecord, index: number): CoordinationFieldDescriptor {
  const id = text(value.id ?? value.field_ref ?? value.fieldRef, `field:${index}`);
  return {
    id,
    label: text(value.label, id),
    valueShape: text(value.value_shape ?? value.valueShape ?? value.shape, 'text'),
    order: number(value.order, index),
    domain: Array.isArray(value.domain) ? value.domain : undefined,
  };
}

function view(value: JsonRecord, index: number): CoordinationViewDescriptor {
  const id = text(value.id ?? value.view_ref ?? value.viewRef, `view:${index}`);
  return {
    id,
    label: text(value.label, id),
    order: number(value.order, index),
    groupBy: text(value.group_by ?? value.groupBy, '') || undefined,
    orderBy: text(value.order_by ?? value.orderBy, '') || undefined,
    filter: value.filter,
    // Arrangement is its own DATA field. We deliberately do NOT fall back to
    // `value.kind` here — on these descriptors `kind` is the envelope type
    // discriminator (`coordination.view.v1`), not an arrangement value, so
    // reading it would leak descriptor vocabulary as a layout (L098). Absent →
    // undefined → the collection's `list` fallback.
    arrangement: text(value.arrangement, '') || undefined,
  };
}

function action(value: JsonRecord, index: number): CoordinationActionDescriptor {
  const id = text(value.id ?? value.action_ref ?? value.actionRef, `action:${index}`);
  return {
    id,
    label: text(value.label, id),
    order: number(value.order, index),
    targetRef: text(value.target_ref ?? value.targetRef, '') || undefined,
    operation: text(value.operation, '') || undefined,
    definitionRef: text(value.definition_ref ?? value.definitionRef, '') || undefined,
    inputMap: value.input_map ?? value.inputMap,
    receiptRef: text(value.receipt_ref ?? value.receiptRef, '') || undefined,
    availability: value.availability,
  };
}

function coordinationRecord(value: JsonRecord, index: number): CoordinationRecord {
  const id = text(value.id ?? value.record_ref ?? value.recordRef, `coordination-record:${index}`);
  const relationships = objects(value.relationships).map(relationship).filter((entry) => entry.targetRef);
  const evidenceRefs = objects(value.evidence_refs ?? value.evidenceRefs).map(evidence).filter((entry) => entry.ownerRef);
  const processSessionRefs = objects(value.process_session_refs ?? value.processSessionRefs)
    .map(processSession)
    .filter((entry) => entry.sessionRef);
  return {
    id,
    label: text(value.label ?? value.title ?? value.name, id),
    fieldValues: isRecord(value.field_values) ? value.field_values : isRecord(value.fieldValues) ? value.fieldValues : {},
    relationships,
    ruleResults: objects(value.rule_results ?? value.ruleResults),
    viewMemberships: objects(value.view_memberships ?? value.viewMemberships),
    actionDescriptorIds: strings(value.action_descriptor_ids ?? value.actionDescriptorIds),
    workflowRefs: objects(value.workflow_refs ?? value.workflowRefs),
    processSessionRefs,
    evidenceRefs,
    raw: value,
  };
}

function byOrderThenLabel<T extends { order: number; label: string }>(values: T[]): T[] {
  return [...values].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function surfaceCopy(value: unknown): CoordinationSurfaceModel['surfaceCopy'] {
  const copy = isRecord(value) ? value : {};
  return {
    title: text(copy.title, 'Work'),
    emptyText: text(copy.empty_text ?? copy.emptyText, 'No work yet.'),
    emptyActionLabel: text(copy.empty_action_label ?? copy.emptyActionLabel, 'Start'),
    runningText: text(copy.running_text ?? copy.runningText, 'Work is running'),
    defaultViewLabel: text(copy.default_view_label ?? copy.defaultViewLabel, 'Board'),
  };
}

export function readCoordinationRecords(input: CoordinationInput): CoordinationSurfaceModel {
  const recordValues = mergeByKind(input, input.coordinationRecords, COORDINATION_KINDS.record);
  const fields = byOrderThenLabel(mergeByKind(input, input.fields, COORDINATION_KINDS.field).map(field));
  const views = byOrderThenLabel(mergeByKind(input, input.views, COORDINATION_KINDS.view).map(view));
  const actions = byOrderThenLabel(mergeByKind(input, input.actions, COORDINATION_KINDS.action).map(action));
  const records = recordValues.map(coordinationRecord);
  const relationships = [
    ...objects(input.relationships),
    ...payloads(input.records, COORDINATION_KINDS.relationship),
    ...records.flatMap((record) => record.relationships),
  ].map(relationship).filter((entry) => entry.targetRef);
  const evidenceRefs = [
    ...objects(input.evidence),
    ...payloads(input.records, COORDINATION_KINDS.evidence),
    ...records.flatMap((record) => record.evidenceRefs),
  ].map(evidence).filter((entry) => entry.ownerRef);
  const processSessions = [
    ...objects(input.processSessions),
    ...payloads(input.records, COORDINATION_KINDS.processSession),
    ...records.flatMap((record) => record.processSessionRefs),
  ].map(processSession).filter((entry) => entry.sessionRef);
  const recoverableIssues = [
    ...objects(input.recoverableIssues),
    ...payloads(input.records, COORDINATION_KINDS.recoverableIssue),
  ].map(recoverableIssue);

  console.info(
    `[marketing-pipeline] projection records=${records.length} fields=${fields.length} actions=${actions.length}`,
  );

  return {
    records,
    fields,
    views,
    actions,
    relationships,
    evidence: evidenceRefs,
    processSessions,
    recoverableIssues,
    surfaceCopy: surfaceCopy(input.surfaceCopy),
    freshness: {
      source: text(input.freshnessSource, 'current-records'),
      recordCount: records.length,
    },
  };
}
