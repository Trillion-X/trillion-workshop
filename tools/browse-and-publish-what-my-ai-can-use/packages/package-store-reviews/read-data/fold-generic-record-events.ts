import {
  type GenericRecordContracts,
  type PlainRecord,
  type ProjectionDescriptor,
  contractIndex,
  isPlainRecord,
  listOfRecords,
  text,
} from './descriptor-contracts';

export interface GenericRecordEvent {
  kind?: string;
  operation?: string;
  record_id: string;
  record_kind?: string;
  relationship_id?: string | null;
  source_record_ref?: string;
  subject_ref?: string;
  actor_ref?: string;
  field_values?: PlainRecord;
  remove?: boolean;
}

export interface ProjectionItem {
  id: string;
  subject_ref: string;
  title: string;
  body: string;
  actor_ref: string;
  time: string;
  score: number | null;
  version_context: string;
  signals: Array<{ id: string; label: string; actor_ref: string }>;
  responses: Array<{ id: string; body: string; actor_ref: string; time: string }>;
  concerns: Array<{ id: string; reason_key: string; actor_ref: string; time: string }>;
  action_descriptor_ids: string[];
  field_values: PlainRecord;
}

export interface GenericProjectionFold {
  reader_id: string;
  projection_id: string;
  state: 'empty' | 'sparse' | 'dense';
  summary: {
    label: string;
    count: number;
    score_average: number | null;
    distribution: Array<{ value: number; count: number }>;
  };
  items: ProjectionItem[];
  filters: Array<{ id: string; label: string; count: number }>;
  actions: Array<{ id: string; label: string; request_kind: string }>;
  issues: Array<{ code: string; detail: string }>;
  trace: {
    input_count: number;
    visible_count: number;
    descriptor_counts: Record<string, number>;
  };
}

function eventFrom(value: unknown): GenericRecordEvent | null {
  if (!isPlainRecord(value)) return null;
  const recordId = text(value.record_id ?? value.id, '');
  if (!recordId) return null;
  return {
    kind: text(value.kind, ''),
    operation: text(value.operation, ''),
    record_id: recordId,
    record_kind: text(value.record_kind, ''),
    relationship_id: text(value.relationship_id, '') || null,
    source_record_ref: text(value.source_record_ref, ''),
    subject_ref: text(value.subject_ref, ''),
    actor_ref: text(value.actor_ref, ''),
    field_values: isPlainRecord(value.field_values) ? value.field_values : {},
    remove: value.remove === true,
  };
}

function value(event: GenericRecordEvent, fieldId?: string): unknown {
  return fieldId ? event.field_values?.[fieldId] : undefined;
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ruleAllows(contracts: GenericRecordContracts, projection: ProjectionDescriptor, event: GenericRecordEvent): boolean {
  const index = contractIndex(contracts);
  const rule = projection.visibility_rule_id ? index.rules.get(projection.visibility_rule_id) : undefined;
  if (!rule?.when) return true;
  const actual = value(event, rule.when.field_id);
  if ('equals' in rule.when) return actual === rule.when.equals;
  if ('not_equals' in rule.when) return actual !== rule.when.not_equals;
  return true;
}

function distribution(scores: number[]): Array<{ value: number; count: number }> {
  const counts = new Map<number, number>();
  for (const score of scores) counts.set(score, (counts.get(score) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([entryValue, count]) => ({ value: entryValue, count }));
}

function linkedBy(events: GenericRecordEvent[], relationshipId?: string): Map<string, GenericRecordEvent[]> {
  const map = new Map<string, GenericRecordEvent[]>();
  if (!relationshipId) return map;
  for (const event of events) {
    if (event.relationship_id !== relationshipId || !event.source_record_ref) continue;
    const list = map.get(event.source_record_ref) ?? [];
    list.push(event);
    map.set(event.source_record_ref, list);
  }
  return map;
}

function stateFor(count: number): GenericProjectionFold['state'] {
  if (count === 0) return 'empty';
  return count > 4 ? 'dense' : 'sparse';
}

export function foldGenericRecordEvents(
  contracts: GenericRecordContracts,
  readerId: string,
  input: { events?: unknown; records?: unknown },
): GenericProjectionFold {
  const index = contractIndex(contracts);
  const reader = index.readers.get(readerId);
  const projection = reader ? index.projections.get(reader.projection_id) : undefined;
  const events = [...listOfRecords(input.events), ...listOfRecords(input.records)]
    .map(eventFrom)
    .filter((event): event is GenericRecordEvent => Boolean(event));
  const issues: GenericProjectionFold['issues'] = [];
  if (!reader) issues.push({ code: 'missing-reader', detail: readerId });
  if (reader && !projection) issues.push({ code: 'missing-projection', detail: reader.projection_id });

  if (!reader || !projection) {
    return {
      reader_id: readerId,
      projection_id: '',
      state: 'empty',
      summary: { label: readerId, count: 0, score_average: null, distribution: [] },
      items: [],
      filters: [],
      actions: [],
      issues,
      trace: { input_count: events.length, visible_count: 0, descriptor_counts: {} },
    };
  }

  const responses = linkedBy(events, projection.response_relationship_id);
  const signals = linkedBy(events, projection.signal_relationship_id);
  const concerns = linkedBy(events, projection.concern_relationship_id);
  const visible = events
    .filter((event) => event.record_kind === projection.item_record_kind)
    .filter((event) => !event.remove)
    .filter((event) => ruleAllows(contracts, projection, event));
  const scores = visible.map((event) => numeric(value(event, projection.score_field_id))).filter((entry): entry is number => entry != null);
  const scoreAverage = scores.length > 0 ? Number((scores.reduce((sum, entry) => sum + entry, 0) / scores.length).toFixed(2)) : null;
  const itemActions = contracts.actions.map((action) => action.id);
  const items = visible.map((event): ProjectionItem => ({
    id: event.record_id,
    subject_ref: text(value(event, projection.subject_field_id), event.subject_ref ?? ''),
    title: text(value(event, projection.title_field_id), event.record_id),
    body: text(value(event, projection.body_field_id), ''),
    actor_ref: text(value(event, projection.actor_field_id), event.actor_ref ?? ''),
    time: text(value(event, projection.time_field_id), ''),
    score: numeric(value(event, projection.score_field_id)),
    version_context: text(value(event, projection.version_field_id), ''),
    signals: (signals.get(event.record_id) ?? []).map((entry) => ({
      id: entry.record_id,
      label: text(entry.field_values?.['signal-label'], entry.record_id),
      actor_ref: text(entry.field_values?.['actor-ref'], entry.actor_ref ?? ''),
    })),
    responses: (responses.get(event.record_id) ?? []).map((entry) => ({
      id: entry.record_id,
      body: text(entry.field_values?.['body-text'], ''),
      actor_ref: text(entry.field_values?.['actor-ref'], entry.actor_ref ?? ''),
      time: text(entry.field_values?.['created-at'], ''),
    })),
    concerns: (concerns.get(event.record_id) ?? []).map((entry) => ({
      id: entry.record_id,
      reason_key: text(entry.field_values?.['reason-key'], ''),
      actor_ref: text(entry.field_values?.['actor-ref'], entry.actor_ref ?? ''),
      time: text(entry.field_values?.['created-at'], ''),
    })),
    action_descriptor_ids: itemActions,
    field_values: event.field_values ?? {},
  }));

  const filterCounts = new Map<string, number>();
  for (const item of items) {
    const key = item.subject_ref || 'all';
    filterCounts.set(key, (filterCounts.get(key) ?? 0) + 1);
  }

  return {
    reader_id: reader.id,
    projection_id: projection.id,
    state: stateFor(items.length),
    summary: {
      label: reader.label,
      count: items.length,
      score_average: scoreAverage,
      distribution: distribution(scores),
    },
    items,
    filters: [...filterCounts.entries()].map(([id, count]) => ({ id, label: id, count })),
    actions: contracts.actions.map((action) => ({ id: action.id, label: action.label, request_kind: action.request_kind })),
    issues,
    trace: {
      input_count: events.length,
      visible_count: items.length,
      descriptor_counts: {
        fields: contracts.fields.length,
        relationships: contracts.relationships.length,
        actions: contracts.actions.length,
        projections: contracts.projections.length,
      },
    },
  };
}
