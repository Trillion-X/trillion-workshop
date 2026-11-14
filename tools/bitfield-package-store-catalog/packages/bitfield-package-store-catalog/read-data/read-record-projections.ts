type JsonRecord = Record<string, unknown>;

export type ProjectionState = 'ready' | 'loading' | 'empty' | 'error';

export interface GenericProjectionBlock {
  id: string;
  render_kind: string;
  role: string;
  label?: string;
  value?: unknown;
  values?: unknown[];
  tone_key?: string;
  source_path?: string[];
}

export interface GenericProjectionAction {
  id: string;
  role: string;
  label: string;
  target: string;
  input: JsonRecord;
  subject?: JsonRecord;
  disabled_reason?: string;
  provenance: JsonRecord;
}

export interface GenericProjectionRecord {
  record_ref: string;
  primary_text: string;
  secondary_text: string;
  sort_key: string;
  search_text: string;
  blocks: GenericProjectionBlock[];
  relationships: Record<string, unknown[]>;
  actions: GenericProjectionAction[];
  source: JsonRecord;
  provenance: JsonRecord;
}

export interface GenericRecordProjection {
  schema: 'generic.record_action_projection.v1';
  projection_id: string;
  state: ProjectionState;
  records: GenericProjectionRecord[];
  definitions: JsonRecord[];
  discovery?: JsonRecord;
  provenance: JsonRecord;
  error?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function object(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function at(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

function pathText(row: JsonRecord, role: JsonRecord, key: 'path' | 'fallback_path', fallback = ''): string {
  const rawPath = list(role[key]).filter((part): part is string => typeof part === 'string');
  return text(at(row, rawPath), fallback);
}

function definitionRows(rawDefinitions: unknown): JsonRecord[] {
  const source = isRecord(rawDefinitions) ? rawDefinitions.records : rawDefinitions;
  return list(source).filter(isRecord);
}

function rowDefinitions(rawDefinitions: unknown): JsonRecord[] {
  const rows = definitionRows(rawDefinitions);
  return rows.length > 0 ? rows : [{
    id: 'record-definition:catalog-row',
    identity_path: ['row_id'],
    field_roles: [
      { role: 'primary_text', path: ['display_name'] },
      { role: 'secondary_text', path: ['summary'] },
      { role: 'search_text', path: ['summary'] },
    ],
    block_roles: [],
    relationship_roles: [],
    action_roles: [],
  }];
}

function catalogRows(rawCatalog: unknown): JsonRecord[] {
  const rows = isRecord(rawCatalog) ? rawCatalog.catalog_rows : undefined;
  return list(rows).filter(isRecord);
}

function blockFromValue(value: unknown, role: JsonRecord, index: number, sourcePath: string[]): GenericProjectionBlock | null {
  if (isRecord(value)) {
    const id = text(value.id, `${text(role.role, 'block')}:${index}`);
    const renderKind = text(value.render_kind, text(role.render_kind, text(value.role, text(role.role, 'text'))));
    const blockRole = text(value.role, text(role.role, 'text'));
    return {
      id,
      render_kind: renderKind,
      role: blockRole,
      label: text(value.label, text(role.label)) || undefined,
      value: value.value,
      values: list(value.values).length > 0 ? list(value.values) : undefined,
      tone_key: text(value.tone_key, text(role.tone_key)) || undefined,
      source_path: sourcePath,
    };
  }
  if (value === undefined || value === null || value === '') return null;
  return {
    id: text(role.id, `${text(role.role, 'block')}:${index}`),
    render_kind: text(role.render_kind, text(role.role, 'text')),
    role: text(role.role, 'text'),
    label: text(role.label) || undefined,
    value,
    tone_key: text(role.tone_key) || undefined,
    source_path: sourcePath,
  };
}

function blocksFromRole(row: JsonRecord, role: JsonRecord, index: number): GenericProjectionBlock[] {
  const path = list(role.path).filter((part): part is string => typeof part === 'string');
  const value = at(row, path);
  if (role.mode === 'spread') {
    return list(value)
      .map((child, childIndex) => blockFromValue(child, role, childIndex, path))
      .filter((block): block is GenericProjectionBlock => block !== null);
  }
  const block = blockFromValue(value, role, index, path);
  return block ? [block] : [];
}

function relationshipsFromRoles(row: JsonRecord, roles: readonly JsonRecord[]): Record<string, unknown[]> {
  const relationships: Record<string, unknown[]> = {};
  for (const role of roles) {
    const roleId = text(role.role);
    const path = list(role.path).filter((part): part is string => typeof part === 'string');
    if (!roleId || path.length === 0) continue;
    const value = at(row, path);
    const values = list(value);
    relationships[roleId] = values.length > 0 ? values : value === undefined || value === null ? [] : [value];
  }
  return relationships;
}

function actionInput(row: JsonRecord, actionRole: JsonRecord): JsonRecord {
  const input: JsonRecord = {};
  const inputPaths = object(actionRole.input_paths);
  for (const [key, rawPath] of Object.entries(inputPaths)) {
    const path = list(rawPath).filter((part): part is string => typeof part === 'string');
    const value = at(row, path);
    if (value !== undefined) input[key] = value;
  }
  return input;
}

function actionFromRole(row: JsonRecord, actionRole: JsonRecord, recordRef: string, index: number): GenericProjectionAction | null {
  const targetPath = list(actionRole.target_path).filter((part): part is string => typeof part === 'string');
  const target = text(at(row, targetPath));
  if (!target) return null;
  const labelPath = list(actionRole.label_path).filter((part): part is string => typeof part === 'string');
  const subjectPath = list(actionRole.subject_path).filter((part): part is string => typeof part === 'string');
  const input = actionInput(row, actionRole);
  return {
    id: `${recordRef}:action:${text(actionRole.role, 'action')}:${index}`,
    role: text(actionRole.role, 'action'),
    label: text(at(row, labelPath), text(actionRole.label, 'Run action')),
    target,
    subject: object(at(row, subjectPath)),
    input,
    disabled_reason: Object.keys(input).length === 0 ? 'Action is missing input data.' : undefined,
    provenance: {
      definition_id: text(actionRole.definition_id),
      source: 'package::bitfield-package-store-catalog::record-definitions',
    },
  };
}

function projectRow(row: JsonRecord, definition: JsonRecord, index: number): GenericProjectionRecord {
  const identityPath = list(definition.identity_path).filter((part): part is string => typeof part === 'string');
  const recordRef = text(at(row, identityPath), text(row.row_id, `record:${index}`));
  const fieldRoles = list(definition.field_roles).filter(isRecord);
  const primaryRole = fieldRoles.find((role) => role.role === 'primary_text') ?? {};
  const secondaryRole = fieldRoles.find((role) => role.role === 'secondary_text') ?? {};
  const searchRole = fieldRoles.find((role) => role.role === 'search_text') ?? {};
  const blocks = list(definition.block_roles)
    .filter(isRecord)
    .flatMap((role, blockIndex) => blocksFromRole(row, role, blockIndex));
  const actions = list(definition.action_roles)
    .filter(isRecord)
    .map((role, actionIndex) => actionFromRole(row, role, recordRef, actionIndex))
    .filter((action): action is GenericProjectionAction => action !== null);

  return {
    record_ref: recordRef,
    primary_text: pathText(row, primaryRole, 'path', text(row.display_name, recordRef)) || pathText(row, primaryRole, 'fallback_path', recordRef),
    secondary_text: pathText(row, secondaryRole, 'path', text(row.summary)) || pathText(row, secondaryRole, 'fallback_path'),
    sort_key: `${String(index).padStart(6, '0')}:${recordRef}`,
    search_text: pathText(row, searchRole, 'path', `${text(row.display_name)} ${text(row.summary)}`).toLowerCase(),
    blocks,
    relationships: relationshipsFromRoles(row, list(definition.relationship_roles).filter(isRecord)),
    actions,
    source: row,
    provenance: {
      definition_id: text(definition.id),
      projection_owner: 'bitfield-package-store-catalog',
    },
  };
}

export function readRecordActionProjection(rawCatalog: unknown, rawDefinitions: unknown): GenericRecordProjection {
  const definitions = rowDefinitions(rawDefinitions);
  const definition = definitions[0] ?? {};
  const records = catalogRows(rawCatalog).map((row, index) => projectRow(row, definition, index));
  const sourceCatalog = object(rawCatalog);
  return {
    schema: 'generic.record_action_projection.v1',
    projection_id: 'package::bitfield-package-store-catalog::projection::catalog-record-actions',
    state: records.length === 0 ? 'empty' : 'ready',
    records,
    definitions,
    ...(isRecord(sourceCatalog.discovery) ? { discovery: sourceCatalog.discovery } : {}),
    provenance: {
      source_catalog_schema: text(sourceCatalog.schema),
      definition_set_id: text(object(rawDefinitions).definition_set_id),
    },
  };
}
