export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type TermsRecordStatus = 'loading' | 'empty' | 'ready' | 'stale' | 'error';

export type GenericFieldDescriptor = {
  id: string;
  label: string;
  role?: string;
  format?: string;
  order?: number;
  params?: Record<string, JsonValue>;
};

export type GenericRuleDescriptor = {
  id: string;
  method: string;
  params?: Record<string, JsonValue>;
};

export type GenericRelationshipDescriptor = {
  id: string;
  role: string;
  target: string;
  params?: Record<string, JsonValue>;
};

export type GenericActionDescriptor = {
  id: string;
  label: string;
  target?: string;
  method?: string;
  enabled?: boolean;
  disabledReason?: string;
  params?: Record<string, JsonValue>;
  process?: GenericProcessDescriptor;
};

export type GenericProcessDescriptor = {
  id: string;
  target: string;
  method: string;
  params?: Record<string, JsonValue>;
};

export type GenericTermsRecord = {
  id: string;
  status?: TermsRecordStatus;
  title?: string;
  summary?: string;
  fields?: Record<string, JsonValue>;
  descriptors?: Record<string, GenericFieldDescriptor>;
  rules?: GenericRuleDescriptor[];
  relationships?: GenericRelationshipDescriptor[];
  actions?: GenericActionDescriptor[];
  order?: number;
  emphasis?: boolean;
};

export type GenericTermsProjectionInput = {
  id?: string;
  status?: TermsRecordStatus;
  title?: string;
  summary?: string;
  records?: GenericTermsRecord[];
  descriptors?: Record<string, GenericFieldDescriptor>;
  actions?: GenericActionDescriptor[];
  freshnessLabel?: string;
  issue?: {
    category: string;
    label: string;
  };
};

export type GenericTermsProjectionConfig = {
  id: string;
  title?: string;
  summary?: string;
  emptyLabel?: string;
  loadingLabel?: string;
  errorLabel?: string;
  staleLabel?: string;
};

export function descriptorList(
  local: Record<string, GenericFieldDescriptor> | undefined,
  global: Record<string, GenericFieldDescriptor> | undefined,
): GenericFieldDescriptor[] {
  return Object.values({ ...(global ?? {}), ...(local ?? {}) }).sort(
    (left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id),
  );
}

export function validateGenericTermsInput(input: GenericTermsProjectionInput): GenericTermsProjectionInput {
  const records = input.records ?? [];
  for (const record of records) {
    requireId(record.id, 'record');
    for (const descriptor of Object.values(record.descriptors ?? {})) validateFieldDescriptor(descriptor);
    for (const rule of record.rules ?? []) validateMethodShape(rule.id, rule.method, 'rule');
    for (const action of record.actions ?? []) validateActionDescriptor(action);
    for (const relation of record.relationships ?? []) {
      requireId(relation.id, 'relationship');
      requireId(relation.role, 'relationship role');
      requireId(relation.target, 'relationship target');
    }
  }
  for (const descriptor of Object.values(input.descriptors ?? {})) validateFieldDescriptor(descriptor);
  for (const action of input.actions ?? []) validateActionDescriptor(action);
  return input;
}

function validateFieldDescriptor(descriptor: GenericFieldDescriptor) {
  requireId(descriptor.id, 'field descriptor');
  requireId(descriptor.label, 'field descriptor label');
}

function validateActionDescriptor(action: GenericActionDescriptor) {
  requireId(action.id, 'action');
  requireId(action.label, 'action label');
  if (action.target !== undefined) requireId(action.target, 'action target');
  if (action.method !== undefined) requireId(action.method, 'action method');
  if (action.process) validateMethodShape(action.process.id, action.process.method, 'process descriptor');
}

function validateMethodShape(id: string, method: string, label: string) {
  requireId(id, label);
  requireId(method, `${label} method`);
}

function requireId(value: string, label: string) {
  if (!value || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}
