export type AnyRecord = Record<string, unknown>;

export interface DescribedRecordFieldDescriptor {
  id: string;
  label: string;
  sourceId?: string;
  valuePath?: string[];
  fallbackValue?: unknown;
  placeholder?: string;
  editable?: boolean;
  multiline?: boolean;
  saveActionId?: string;
  visibleWhen?: RuleDescriptor[];
}

export interface DescribedRecordActionDescriptor {
  id: string;
  label: string;
  target?: string;
  method?: string;
  enabled?: boolean;
  disabledReason?: string;
  intent?: string;
  input?: AnyRecord;
  bindings?: BindingDescriptor[];
  visibleWhen?: RuleDescriptor[];
}

export interface DescribedRecordRelationshipDescriptor {
  id: string;
  label?: string;
  sourceId?: string;
  itemPath?: string[];
  emptyLabel?: string;
  fields?: Array<{ key: string; path?: string[] }>;
  visibleWhen?: RuleDescriptor[];
}

export interface DescribedRecordSurfaceDescriptor {
  kind: 'described-record-surface';
  surfaceId: string;
  identity?: {
    titlePath?: string[];
    subtitlePath?: string[];
    markPath?: string[];
    badgesPath?: string[];
    fallbackTitle?: string;
  };
  fields?: DescribedRecordFieldDescriptor[];
  relationships?: DescribedRecordRelationshipDescriptor[];
  actions?: DescribedRecordActionDescriptor[];
  diagnostics?: {
    exposeRefs?: boolean;
  };
}

export interface BindingDescriptor {
  key: string;
  source?: string;
  path?: string[];
  value?: unknown;
}

export interface RuleDescriptor {
  source?: string;
  path?: string[];
  equals?: unknown;
  notEquals?: unknown;
  exists?: boolean;
}

export interface DescribedRecordProjectionInput {
  descriptor: DescribedRecordSurfaceDescriptor;
  sources?: Record<string, unknown>;
  readerId?: string;
}

export interface DescribedRecordField {
  id: string;
  label: string;
  value: unknown;
  placeholder?: string;
  editable: boolean;
  multiline: boolean;
  saveActionId?: string;
}

export interface DescribedRecordRelationshipItem {
  id: string;
  values: Record<string, unknown>;
}

export interface DescribedRecordRelationship {
  id: string;
  label?: string;
  emptyLabel?: string;
  items: DescribedRecordRelationshipItem[];
}

export interface DescribedRecordAction {
  id: string;
  label: string;
  enabled: boolean;
  disabledReason?: string;
  intent: string;
}

export interface DescribedRecordSurface {
  kind: 'described-record-surface-materialization';
  surfaceId: string;
  readerId: string;
  identity: {
    title: string;
    subtitle?: string;
    mark?: unknown;
    badges: unknown[];
  };
  fields: DescribedRecordField[];
  relationships: DescribedRecordRelationship[];
  actions: DescribedRecordAction[];
  diagnostics: {
    sourceIds: string[];
    problems: Array<{ id: string; detail: string }>;
  };
}

function isObject(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function objectList(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function readPath(source: unknown, path: string[] = []): unknown {
  return path.reduce((current, segment) => (isObject(current) ? current[segment] : undefined), source);
}

function sourceValue(sources: Record<string, unknown>, sourceId: string | undefined, path: string[] = []): unknown {
  const source = sourceId ? sources[sourceId] : sources.record ?? sources.default;
  return readPath(source, path);
}

function ruleMatches(rule: RuleDescriptor, sources: Record<string, unknown>): boolean {
  const value = sourceValue(sources, rule.source, rule.path);
  if (rule.exists !== undefined) return rule.exists ? value !== undefined && value !== null : value === undefined || value === null;
  if (rule.equals !== undefined) return value === rule.equals;
  if (rule.notEquals !== undefined) return value !== rule.notEquals;
  return true;
}

function visible(rules: RuleDescriptor[] | undefined, sources: Record<string, unknown>): boolean {
  return (rules ?? []).every((rule) => ruleMatches(rule, sources));
}

function fieldValue(field: DescribedRecordFieldDescriptor, sources: Record<string, unknown>): unknown {
  const value = sourceValue(sources, field.sourceId, field.valuePath);
  return value === undefined || value === null ? field.fallbackValue ?? '' : value;
}

function relationshipItems(
  relationship: DescribedRecordRelationshipDescriptor,
  sources: Record<string, unknown>,
): DescribedRecordRelationshipItem[] {
  const rows = objectList(sourceValue(sources, relationship.sourceId, relationship.itemPath));
  return rows.map((row, index) => {
    const values = Object.fromEntries(
      (relationship.fields ?? []).map((field) => [field.key, readPath(row, field.path ?? [field.key])]),
    );
    return {
      id: text(row.id ?? row.ref, `${relationship.id}:${index}`),
      values,
    };
  });
}

function diagnostics(
  descriptor: DescribedRecordSurfaceDescriptor,
  sources: Record<string, unknown>,
): DescribedRecordSurface['diagnostics'] {
  const problems: Array<{ id: string; detail: string }> = [];
  if (!descriptor.surfaceId) problems.push({ id: 'missing-surface-id', detail: 'surfaceId is required' });
  return {
    sourceIds: descriptor.diagnostics?.exposeRefs ? Object.keys(sources).sort() : [],
    problems,
  };
}

export function projectDescribedRecordSurface(input: DescribedRecordProjectionInput): DescribedRecordSurface {
  const sources = input.sources ?? {};
  const descriptor = input.descriptor;
  const identitySource = sources.identity ?? sources.record ?? sources.default ?? {};
  const identity = descriptor.identity ?? {};
  const title = text(readPath(identitySource, identity.titlePath), text(identity.fallbackTitle, descriptor.surfaceId));
  const subtitle = text(readPath(identitySource, identity.subtitlePath), '');
  const badges = objectList(readPath(identitySource, identity.badgesPath));

  return {
    kind: 'described-record-surface-materialization',
    surfaceId: descriptor.surfaceId,
    readerId: input.readerId ?? 'default-reader',
    identity: {
      title,
      subtitle: subtitle || undefined,
      mark: readPath(identitySource, identity.markPath),
      badges,
    },
    fields: (descriptor.fields ?? [])
      .filter((field) => visible(field.visibleWhen, sources))
      .map((field) => ({
        id: field.id,
        label: field.label,
        value: fieldValue(field, sources),
        placeholder: field.placeholder,
        editable: field.editable === true,
        multiline: field.multiline === true,
        saveActionId: field.saveActionId,
      })),
    relationships: (descriptor.relationships ?? [])
      .filter((relationship) => visible(relationship.visibleWhen, sources))
      .map((relationship) => ({
        id: relationship.id,
        label: relationship.label,
        emptyLabel: relationship.emptyLabel,
        items: relationshipItems(relationship, sources),
      })),
    actions: (descriptor.actions ?? [])
      .filter((action) => visible(action.visibleWhen, sources))
      .map((action) => ({
        id: action.id,
        label: action.label,
        enabled: action.enabled !== false,
        disabledReason: action.disabledReason,
        intent: action.intent ?? 'neutral',
      })),
    diagnostics: diagnostics(descriptor, sources),
  };
}
