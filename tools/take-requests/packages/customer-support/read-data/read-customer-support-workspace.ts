import {
  OwnerEvidence,
  RecordWorkGraph,
  RecordWorkGraphInput,
  WorkDescriptor,
  WorkRecord,
  readRecordWorkGraph,
  text,
} from './record-work-graph';

export interface CustomerSupportWorkspace {
  status: string;
  records: Array<WorkRecord & { evidence: OwnerEvidence[]; actions: WorkDescriptor[] }>;
  views: WorkDescriptor[];
  fields: WorkDescriptor[];
  actions: WorkDescriptor[];
  rules: WorkDescriptor[];
  projections: WorkDescriptor[];
  copy: Record<string, string>;
  issues: string[];
}

function copyMap(graph: RecordWorkGraph): Record<string, string> {
  return Object.fromEntries(graph.copyDescriptors.map((entry) => [entry.id, entry.label]));
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function evidenceByRef(items: OwnerEvidence[]): Map<string, OwnerEvidence> {
  return new Map(items.map((item) => [item.ref, item]));
}

export function readCustomerSupportWorkspace(input: RecordWorkGraphInput & { status?: string }): CustomerSupportWorkspace {
  const graph = readRecordWorkGraph(input);
  const evidence = evidenceByRef(graph.ownerEvidence);
  const actions = byId(graph.actionDescriptors);
  const records = graph.workRecords.map((record) => ({
    ...record,
    evidence: record.ownerRefs.map((ref) => evidence.get(ref)).filter((item): item is OwnerEvidence => !!item),
    actions: record.actionRefs.map((ref) => actions.get(ref)).filter((item): item is WorkDescriptor => !!item),
  }));
  const missingEvidence = graph.workRecords.flatMap((record) =>
    record.ownerRefs.filter((ref) => !evidence.has(ref)).map((ref) => `${record.id}:${ref}`),
  );
  return {
    status: text(input.status, records.length === 0 ? 'empty' : records.length > 12 ? 'dense' : 'sparse'),
    records,
    views: graph.viewDescriptors,
    fields: graph.fieldDescriptors,
    actions: graph.actionDescriptors,
    rules: graph.ruleDescriptors,
    projections: graph.projectionDescriptors,
    copy: copyMap(graph),
    issues: missingEvidence.map((ref) => `missing-owner-evidence:${ref}`),
  };
}

