export type JsonObject = Record<string, unknown>;

export interface UniversalActionEventFieldDescriptor {
  id: string;
  label: string;
  role?: string;
  paths?: readonly (readonly string[])[];
  display?: {
    order?: number;
    emptyText?: string;
  };
}

export interface UniversalActionEventDomainOptionDescriptor {
  id: string;
  label: string;
  role?: string;
  group?: string;
  tone?: string;
  order?: number;
  copy?: JsonObject;
}

export interface UniversalActionEventRelationshipDescriptor {
  id: string;
  fromRole?: string;
  toRole?: string;
  label?: string;
  cardinality?: string;
}

export interface UniversalActionEventProofDescriptor {
  id: string;
  label?: string;
  sourceRef?: string;
  paths?: readonly (readonly string[])[];
  disclosure?: 'summary' | 'support' | 'hidden';
  errorText?: string;
  order?: number;
}

export interface UniversalActionEventProcessProofDescriptor {
  id: string;
  label?: string;
  sessionRefPath?: readonly string[];
  eventFeedRefPath?: readonly string[];
  summaryPaths?: readonly (readonly string[])[];
  proofDescriptorId?: string;
}

export interface UniversalActionEventActionDescriptor {
  id: string;
  label: string;
  target?: string;
  operation?: string;
  definitionId?: string;
  input?: JsonObject;
  inputMapping?: readonly UniversalActionEventInputMapping[];
  availability?: {
    requiresRoute?: boolean;
    disabledReasonId?: string;
    readOnlyReasonId?: string;
  };
  offlinePolicy?: string;
}

export interface UniversalActionEventInputMapping {
  key: string;
  from?: readonly string[];
  value?: unknown;
}

export interface UniversalActionEventViewDescriptor {
  id: string;
  label: string;
  rowFields?: readonly string[];
  detailFields?: readonly string[];
  proofDescriptors?: readonly string[];
  actions?: readonly string[];
  groupByRole?: string;
  sort?: readonly {
    field: string;
    direction?: 'asc' | 'desc';
  }[];
  copy?: {
    emptyTitle?: string;
    emptyDetail?: string;
    errorTitle?: string;
    freshnessLabel?: string;
  };
}

export interface UniversalActionEventRuleDescriptor {
  id: string;
  message: string;
  severity?: string;
  when?: JsonObject;
}

export interface UniversalActionEventRecord {
  recordId: string;
  subjectRefs?: readonly string[];
  actorRefs?: readonly string[];
  sourceRefs?: readonly string[];
  actionRef?: string;
  fieldValues?: JsonObject;
  domainOptionRefs?: readonly string[];
  relationshipRefs?: readonly string[];
  ruleEvalRefs?: readonly string[];
  proofRefs?: readonly string[];
  processSessionRefs?: readonly string[];
  ownerActionRefs?: readonly string[];
  occurredAt?: string;
  idempotenceKey?: string;
  payload?: JsonObject;
}

export interface UniversalActionEventDescriptorSet {
  fields?: readonly UniversalActionEventFieldDescriptor[];
  domainOptions?: readonly UniversalActionEventDomainOptionDescriptor[];
  relationships?: readonly UniversalActionEventRelationshipDescriptor[];
  proofs?: readonly UniversalActionEventProofDescriptor[];
  processProofs?: readonly UniversalActionEventProcessProofDescriptor[];
  actions?: readonly UniversalActionEventActionDescriptor[];
  views?: readonly UniversalActionEventViewDescriptor[];
  rules?: readonly UniversalActionEventRuleDescriptor[];
  disabledReasons?: Readonly<Record<string, string>>;
}

export interface UniversalActionEventModelValue {
  fieldId: string;
  label: string;
  value: unknown;
  text: string;
}

export interface UniversalActionEventModelOption {
  id: string;
  label: string;
  role?: string;
  group?: string;
  tone?: string;
  order: number;
}

export interface UniversalActionEventModelProof {
  id: string;
  label: string;
  text: string;
  disclosure: 'summary' | 'support' | 'hidden';
  sourceRef?: string;
  error?: string;
}

export interface UniversalActionEventModelAction {
  id: string;
  label: string;
  target?: string;
  operation: string;
  definitionId?: string;
  disabled: boolean;
  disabledReason?: string;
}

export interface UniversalActionEventModelRow {
  id: string;
  occurredAt?: string;
  sortKey: string;
  values: readonly UniversalActionEventModelValue[];
  options: readonly UniversalActionEventModelOption[];
  proofs: readonly UniversalActionEventModelProof[];
  actions: readonly UniversalActionEventModelAction[];
  refs: {
    subjects: readonly string[];
    actors: readonly string[];
    sources: readonly string[];
    processSessions: readonly string[];
  };
}

export interface UniversalActionEventModelGroup {
  id: string;
  label: string;
  rows: readonly UniversalActionEventModelRow[];
}

export interface UniversalActionEventModel {
  viewId: string;
  title: string;
  rows: readonly UniversalActionEventModelRow[];
  groups: readonly UniversalActionEventModelGroup[];
  selected: UniversalActionEventModelRow | null;
  empty: {
    title: string;
    detail: string;
  };
  freshness?: {
    label: string;
    value?: string;
  };
  proof: {
    recordCount: number;
    descriptorCount: number;
  };
}

export function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function objectList(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

export function readPath(value: unknown, path: readonly string[] = []): unknown {
  let current = value;
  for (const segment of path) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function requireDescriptorIds<T extends { id?: string }>(rows: readonly T[], kind: string): T[] {
  return rows.map((row, index) => {
    if (!row.id) throw new Error(`${kind} descriptor at index ${index} has no id`);
    return row;
  });
}
