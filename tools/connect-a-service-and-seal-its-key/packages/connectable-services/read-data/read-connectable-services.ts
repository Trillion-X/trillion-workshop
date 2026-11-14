// package-set://bitfield-studio/packages/connectable-services/read-data/read-connectable-services.ts
//
// Pure descriptor projection helpers for connectable-services. The package reads
// generic descriptor/value/action rows and returns human-facing projection rows
// plus owner action intents. Provider names and field choices are Society data.

export type ProjectionSlotName = 'title' | 'subtitle' | 'supporting_text' | 'badge';

export interface FieldDescriptor {
  id: string;
  roles: string[];
  label?: string;
}

export interface ActionDescriptor {
  id: string;
  label: string;
  target_ref: string;
  operation_ref: string;
  definition_ref?: string;
  input_bindings: ActionInputBinding[];
  rule_refs: string[];
  proof_refs: string[];
}

export interface ActionInputBinding {
  from: string;
  to: string;
}

export interface ProjectionDescriptor {
  id: string;
  record_kind_ref: string;
  slots: Partial<Record<ProjectionSlotName, string>>;
  action_refs: string[];
}

export interface ProjectedActionIntent {
  descriptor_id: string;
  label: string;
  target_ref: string;
  operation_ref: string;
  definition_ref?: string;
  input: Record<string, unknown>;
  input_bindings: ActionInputBinding[];
  rule_refs: string[];
  proof_refs: string[];
  disabled: boolean;
  disabled_reason?: string;
}

export interface ProjectedRecord {
  id: string;
  record_kind: string;
  title: string;
  subtitle: string;
  supporting_text: string;
  badges: string[];
  actions: ProjectedActionIntent[];
  search_tokens: string[];
}

export interface ProjectionModel {
  records: ProjectedRecord[];
  descriptors: {
    field_count: number;
    action_count: number;
    projection_count: number;
  };
}

interface ValueFact {
  record_id: string;
  record_kind: string;
  field_ref: string;
  value: unknown;
}

interface RuleResult {
  record_id: string;
  rule_ref: string;
  enabled: boolean;
  reason?: string;
}

interface DescriptorState {
  fields: Map<string, FieldDescriptor>;
  actions: Map<string, ActionDescriptor>;
  projections: ProjectionDescriptor[];
  values: ValueFact[];
  rules: RuleResult[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(readString).filter(Boolean) : [];
}

function readBindingArray(value: unknown): ActionInputBinding[] {
  return Array.isArray(value)
    ? value
        .map(asRecord)
        .filter((entry): entry is Record<string, unknown> => !!entry)
        .map((entry) => ({ from: readString(entry.from), to: readString(entry.to) }))
        .filter((entry) => entry.from && entry.to)
    : [];
}

function cleanRow(row: unknown): Record<string, unknown> | null {
  const record = asRecord(row);
  const payload = asRecord(record?.payload);
  return payload ?? record;
}

export function extractDomain(url: string): string {
  try {
    const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
    const parsed = new URL(normalizedUrl);
    const domain = parsed.hostname || '';
    return domain.startsWith('www.') ? domain.slice(4) : domain;
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] || '';
  }
}

export function decodeConnectableServicesFeed(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw)
    ? raw
        .map(cleanRow)
        .filter((entry): entry is Record<string, unknown> => !!entry)
    : [];
}

function readProjectionSlots(value: unknown): ProjectionDescriptor['slots'] {
  const slots = asRecord(value) ?? {};
  return {
    title: readString(slots.title),
    subtitle: readString(slots.subtitle),
    supporting_text: readString(slots.supporting_text),
    badge: readString(slots.badge),
  };
}

function parseState(rows: Record<string, unknown>[]): DescriptorState {
  const state: DescriptorState = {
    fields: new Map(),
    actions: new Map(),
    projections: [],
    values: [],
    rules: [],
  };

  for (const row of rows) {
    const kind = readString(row.kind);

    if (kind === 'connectable.field-descriptor') {
      const id = readString(row.id);
      if (!id) continue;
      state.fields.set(id, {
        id,
        label: readString(row.label),
        roles: readStringArray(row.roles),
      });
      continue;
    }

    if (kind === 'connectable.action-descriptor') {
      const id = readString(row.id);
      const target_ref = readString(row.target_ref);
      const operation_ref = readString(row.operation_ref);
      if (!id || !target_ref || !operation_ref) continue;
      const definition_ref = readString(row.definition_ref);
      state.actions.set(id, {
        id,
        label: readString(row.label) || id,
        target_ref,
        operation_ref,
        definition_ref: definition_ref || undefined,
        input_bindings: readBindingArray(row.input_bindings),
        rule_refs: readStringArray(row.rule_refs),
        proof_refs: readStringArray(row.proof_refs),
      });
      continue;
    }

    if (kind === 'connectable.projection-descriptor') {
      const id = readString(row.id);
      const record_kind_ref = readString(row.record_kind_ref);
      if (!id || !record_kind_ref) continue;
      state.projections.push({
        id,
        record_kind_ref,
        slots: readProjectionSlots(row.slots),
        action_refs: readStringArray(row.action_refs),
      });
      continue;
    }

    if (kind === 'connectable.value-fact') {
      const record_id = readString(row.record_id);
      const record_kind = readString(row.record_kind);
      const field_ref = readString(row.field_ref);
      if (!record_id || !record_kind || !field_ref) continue;
      state.values.push({ record_id, record_kind, field_ref, value: row.value });
      continue;
    }

    if (kind === 'connectable.rule-result') {
      const record_id = readString(row.record_id);
      const rule_ref = readString(row.rule_ref);
      if (!record_id || !rule_ref) continue;
      state.rules.push({
        record_id,
        rule_ref,
        enabled: row.enabled !== false,
        reason: readString(row.reason) || undefined,
      });
    }
  }

  return state;
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function buildInput(
  bindings: ActionInputBinding[],
  recordId: string,
  values: Map<string, string>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  for (const binding of bindings) {
    if (binding.from === 'record.id') {
      input[binding.to] = recordId;
      continue;
    }

    const value = values.get(binding.from);
    if (value !== undefined) input[binding.to] = value;
  }

  return input;
}

function ruleState(ruleRefs: string[], rules: RuleResult[]): { disabled: boolean; reason?: string } {
  for (const ruleRef of ruleRefs) {
    const result = rules.find((rule) => rule.rule_ref === ruleRef);
    if (result && !result.enabled) return { disabled: true, reason: result.reason };
  }

  return { disabled: false };
}

export function projectConnectableServices(rows: Record<string, unknown>[]): ProjectionModel {
  const state = parseState(rows);
  const projection = state.projections[0];
  if (!projection) {
    return {
      records: [],
      descriptors: {
        field_count: state.fields.size,
        action_count: state.actions.size,
        projection_count: state.projections.length,
      },
    };
  }

  const valuesByRecord = new Map<string, { kind: string; values: Map<string, string> }>();
  for (const fact of state.values) {
    if (fact.record_kind !== projection.record_kind_ref) continue;
    const current = valuesByRecord.get(fact.record_id) ?? {
      kind: fact.record_kind,
      values: new Map<string, string>(),
    };
    current.values.set(fact.field_ref, valueText(fact.value));
    valuesByRecord.set(fact.record_id, current);
  }

  const records = Array.from(valuesByRecord, ([id, record]) => {
    const rules = state.rules.filter((rule) => rule.record_id === id);
    const actions = projection.action_refs
      .map((ref) => state.actions.get(ref))
      .filter((action): action is ActionDescriptor => !!action)
      .map((action) => {
        const disabledState = ruleState(action.rule_refs, rules);
        return {
          descriptor_id: action.id,
          label: action.label,
          target_ref: action.target_ref,
          operation_ref: action.operation_ref,
          definition_ref: action.definition_ref,
          input: buildInput(action.input_bindings, id, record.values),
          input_bindings: action.input_bindings,
          rule_refs: action.rule_refs,
          proof_refs: action.proof_refs,
          disabled: disabledState.disabled,
          disabled_reason: disabledState.reason,
        };
      });

    const badge = record.values.get(projection.slots.badge ?? '') ?? '';
    const search_tokens = Array.from(record.values.values()).filter(Boolean);

    return {
      id,
      record_kind: record.kind,
      title: record.values.get(projection.slots.title ?? '') ?? id,
      subtitle: record.values.get(projection.slots.subtitle ?? '') ?? '',
      supporting_text: record.values.get(projection.slots.supporting_text ?? '') ?? '',
      badges: badge ? [badge] : [],
      actions,
      search_tokens,
    };
  });

  return {
    records,
    descriptors: {
      field_count: state.fields.size,
      action_count: state.actions.size,
      projection_count: state.projections.length,
    },
  };
}

export function matchConnectableServices(
  rows: Record<string, unknown>[],
  searchDomain: string | null,
): ProjectionModel {
  const model = projectConnectableServices(rows);
  if (!searchDomain) return { ...model, records: [] };
  const normalized = searchDomain.toLowerCase();

  return {
    ...model,
    records: model.records.filter((record) =>
      record.search_tokens.some((token) => token.toLowerCase().includes(normalized)),
    ),
  };
}
