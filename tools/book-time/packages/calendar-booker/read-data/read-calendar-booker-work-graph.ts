export type AnyRecord = Record<string, unknown>;

export interface PublishedRecordRow {
  address?: string;
  payload?: unknown;
}

export interface CalendarBookerDescriptor {
  id: string;
  kind: string;
  ownerPackage: string;
  sourceRecordRef?: string;
  proofLabel: string;
  raw: AnyRecord;
}

export interface CalendarBookerWorkGraph {
  status: string;
  descriptors: CalendarBookerDescriptor[];
  descriptorsByKind: Record<string, CalendarBookerDescriptor[]>;
  recordDescriptors: CalendarBookerDescriptor[];
  fieldDescriptors: CalendarBookerDescriptor[];
  stateDescriptors: CalendarBookerDescriptor[];
  displayLabelDescriptors: CalendarBookerDescriptor[];
  projectionViewDescriptors: CalendarBookerDescriptor[];
  ownerActionDescriptors: CalendarBookerDescriptor[];
  relationshipDescriptors: CalendarBookerDescriptor[];
  validationRuleDescriptors: CalendarBookerDescriptor[];
  processReceiptDescriptors: CalendarBookerDescriptor[];
  freshnessRuleDescriptors: CalendarBookerDescriptor[];
  readinessDescriptors: CalendarBookerDescriptor[];
  sourceRecords: AnyRecord[];
  receiptRecords: AnyRecord[];
  selectedRecordId?: string;
  proof: {
    descriptorRefs: string[];
    sourceRecordCounts: Record<string, number>;
    actionRefs: string[];
    receiptRefs: string[];
    issues: string[];
  };
}

export interface CalendarBookerWorkGraphInput {
  records?: PublishedRecordRow[];
  descriptors?: AnyRecord[];
  sourceRecords?: AnyRecord[];
  receiptRecords?: AnyRecord[];
  selectedRecordId?: string;
  status?: string;
  issues?: unknown[];
}

const DESCRIPTOR_KINDS = new Set([
  'record_descriptor',
  'field_descriptor',
  'state_descriptor',
  'display_label_descriptor',
  'projection_view_descriptor',
  'owner_action_descriptor',
  'relationship_descriptor',
  'validation_rule_descriptor',
  'process_receipt_descriptor',
  'freshness_rule_descriptor',
  'readiness_descriptor',
]);

function isObject(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function objects(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function payloads(rows: PublishedRecordRow[] | undefined): AnyRecord[] {
  return (rows ?? []).map((row) => row.payload).filter(isObject);
}

function descriptor(record: AnyRecord, index: number): CalendarBookerDescriptor {
  const id = text(record.descriptor_id ?? record.id ?? record.ref, `descriptor:calendar-booker:unknown:${index}`);
  return {
    id,
    kind: text(record.kind, 'unknown_descriptor'),
    ownerPackage: text(record.owner_package, 'calendar-booker'),
    sourceRecordRef: text(record.source_record_ref, '') || undefined,
    proofLabel: text(record.proof_label, id),
    raw: record,
  };
}

function bucket(descriptors: CalendarBookerDescriptor[]): Record<string, CalendarBookerDescriptor[]> {
  const byKind: Record<string, CalendarBookerDescriptor[]> = {};
  for (const item of descriptors) {
    byKind[item.kind] = [...(byKind[item.kind] ?? []), item];
  }
  return byKind;
}

function countByKind(records: AnyRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const kind = text(record.kind, 'unknown');
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

function stableStatus(input: CalendarBookerWorkGraphInput, sourceCount: number, issues: string[]): string {
  const supplied = text(input.status, '');
  if (supplied) return supplied;
  if (issues.length > 0) return 'error';
  if (sourceCount === 0) return 'empty';
  return sourceCount > 12 ? 'dense' : 'sparse';
}

export function readCalendarBookerWorkGraph(input: CalendarBookerWorkGraphInput): CalendarBookerWorkGraph {
  const explicitDescriptors = objects(input.descriptors);
  const rowPayloads = payloads(input.records);
  const descriptorRows = [...explicitDescriptors, ...rowPayloads.filter((payload) => DESCRIPTOR_KINDS.has(text(payload.kind)))];
  const descriptors = descriptorRows
    .map(descriptor)
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  const descriptorsByKind = bucket(descriptors);
  const sourceRecords = [...objects(input.sourceRecords), ...rowPayloads.filter((payload) => !DESCRIPTOR_KINDS.has(text(payload.kind)))];
  const receiptRecords = objects(input.receiptRecords);
  const issues = objects(input.issues).map((issue) => text(issue.detail ?? issue.code, '')).filter(Boolean);
  const actionRefs = (descriptorsByKind.owner_action_descriptor ?? [])
    .map((item) => text(item.raw.action_ref, item.id))
    .filter(Boolean);
  const receiptRefs = receiptRecords.map((record, index) => text(record.ref ?? record.id, `receipt:${index}`));

  return {
    status: stableStatus(input, sourceRecords.length, issues),
    descriptors,
    descriptorsByKind,
    recordDescriptors: descriptorsByKind.record_descriptor ?? [],
    fieldDescriptors: descriptorsByKind.field_descriptor ?? [],
    stateDescriptors: descriptorsByKind.state_descriptor ?? [],
    displayLabelDescriptors: descriptorsByKind.display_label_descriptor ?? [],
    projectionViewDescriptors: descriptorsByKind.projection_view_descriptor ?? [],
    ownerActionDescriptors: descriptorsByKind.owner_action_descriptor ?? [],
    relationshipDescriptors: descriptorsByKind.relationship_descriptor ?? [],
    validationRuleDescriptors: descriptorsByKind.validation_rule_descriptor ?? [],
    processReceiptDescriptors: descriptorsByKind.process_receipt_descriptor ?? [],
    freshnessRuleDescriptors: descriptorsByKind.freshness_rule_descriptor ?? [],
    readinessDescriptors: descriptorsByKind.readiness_descriptor ?? [],
    sourceRecords,
    receiptRecords,
    selectedRecordId: text(input.selectedRecordId, '') || undefined,
    proof: {
      descriptorRefs: descriptors.map((item) => item.id),
      sourceRecordCounts: countByKind(sourceRecords),
      actionRefs,
      receiptRefs,
      issues,
    },
  };
}
