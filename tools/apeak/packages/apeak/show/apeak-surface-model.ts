import type { AdvanceCondition, SessionSummary } from '@/packages/ui/show/protocol-session/protocol-session-machine';

export type ApeakAction = {
  id: string;
  label: string;
  target: string;
  operation?: string;
  input?: Record<string, unknown>;
  definitionId?: string;
  icon?: string;
  tone?: string;
};

export type ApeakRow = {
  id: string;
  label: string;
  sourceId?: string;
  fields: Record<string, unknown>;
  actions: ApeakAction[];
};

export type ApeakField = {
  id: string;
  label: string;
  paths: string[][];
  role?: string;
  roleConfig?: Record<string, unknown>;
  rowsWhere?: {
    field: string;
    in?: Array<string | number>;
    equals?: string | number;
  };
};

export type ApeakView = {
  id: string;
  label: string;
  fields: ApeakField[];
  look?: { width?: string };
  statusOverrides?: Record<string, { label?: string; tone?: string; toneColor?: string; ring?: boolean; complete?: boolean; dimmed?: boolean; bubble?: string }>;
};

export type ApeakSurfaceSource = {
  view: ApeakView;
  records: ApeakRow[];
};

export type ApeakSection = {
  field: ApeakField;
  rows: ApeakRow[];
};

export type OverlayMapping = {
  from: { record?: 'first'; path: string[] };
  to: { row_id: string; field: string };
  visibleWhen?: { op: 'present' | 'gt' | 'gte' | 'eq' | 'lt'; value?: number };
  display?: { template?: string };
};

export type MountActionValues = {
  request_id?: string;
  fields?: Record<string, unknown>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function pickPath(value: unknown, path: string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function normalizeAction(value: unknown): ApeakAction | null {
  if (!isRecord(value)) return null;
  const id = readText(value.id);
  const label = readText(value.label);
  const target = readText(value.target);
  if (!id || !label || !target) return null;
  return {
    id,
    label,
    target,
    ...(readText(value.operation) ? { operation: String(value.operation) } : {}),
    ...(isRecord(value.input) ? { input: value.input } : {}),
    ...(readText(value.definitionId) ? { definitionId: String(value.definitionId) } : {}),
    ...(readText(value.icon) ? { icon: String(value.icon) } : {}),
    ...(readText(value.tone) ? { tone: String(value.tone) } : {}),
  };
}

function normalizeRow(value: unknown): ApeakRow | null {
  if (!isRecord(value)) return null;
  const id = readText(value.id);
  const label = readText(value.label) ?? id;
  if (!id || !label) return null;
  return {
    id,
    label,
    ...(readText(value.sourceId) ? { sourceId: String(value.sourceId) } : {}),
    fields: isRecord(value.fields) ? value.fields : {},
    actions: Array.isArray(value.actions) ? value.actions.map(normalizeAction).filter((x): x is ApeakAction => x !== null) : [],
  };
}

function normalizeField(value: unknown): ApeakField | null {
  if (!isRecord(value)) return null;
  const id = readText(value.id);
  const label = readText(value.label) ?? id;
  if (!id || !label) return null;
  const paths = Array.isArray(value.paths)
    ? value.paths.filter((path): path is string[] => Array.isArray(path) && path.every((segment) => typeof segment === 'string'))
    : [];
  return {
    id,
    label,
    paths,
    ...(readText(value.role) ? { role: String(value.role) } : {}),
    ...(isRecord(value.roleConfig) ? { roleConfig: value.roleConfig } : {}),
    ...(isRecord(value.rowsWhere) ? { rowsWhere: value.rowsWhere as ApeakField['rowsWhere'] } : {}),
  };
}

function normalizeView(value: unknown): ApeakView | null {
  if (!isRecord(value)) return null;
  const id = readText(value.id);
  const label = readText(value.label) ?? id;
  const fields = Array.isArray(value.fields) ? value.fields.map(normalizeField).filter((x): x is ApeakField => x !== null) : [];
  if (!id || !label || fields.length === 0) return null;
  return {
    id,
    label,
    fields,
    ...(isRecord(value.look) ? { look: value.look as ApeakView['look'] } : {}),
    ...(isRecord(value.statusOverrides) ? { statusOverrides: value.statusOverrides as ApeakView['statusOverrides'] } : {}),
  };
}

export function readSurfaceInput(props: Record<string, unknown>): unknown {
  return props.surfaceInput ?? props.surface_input;
}

export function readProjectionAddress(surfaceInput: unknown): string | null {
  if (!isRecord(surfaceInput)) return null;
  return readText(surfaceInput.projection_address) ?? null;
}

export function readOverlayAddress(surfaceInput: unknown): string | null {
  if (!isRecord(surfaceInput)) return null;
  return readText(surfaceInput.overlay_address) ?? null;
}

export function readOverlayMappings(surfaceInput: unknown): OverlayMapping[] {
  if (!isRecord(surfaceInput) || !Array.isArray(surfaceInput.overlay_mappings)) return [];
  return surfaceInput.overlay_mappings.filter((value): value is OverlayMapping => {
    if (!isRecord(value) || !isRecord(value.from) || !isRecord(value.to)) return false;
    return Array.isArray(value.from.path)
      && value.from.path.every((segment) => typeof segment === 'string')
      && typeof value.to.row_id === 'string'
      && typeof value.to.field === 'string';
  });
}

function passesGate(value: unknown, gate: OverlayMapping['visibleWhen']): boolean {
  if (!gate) return true;
  if (gate.op === 'present') {
    if (value === null || value === undefined) return false;
    return String(value).trim().length > 0;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return false;
  const target = typeof gate.value === 'number' ? gate.value : 0;
  switch (gate.op) {
    case 'gt':
      return numeric > target;
    case 'gte':
      return numeric >= target;
    case 'eq':
      return numeric === target;
    case 'lt':
      return numeric < target;
    default:
      return false;
  }
}

function formatOverlayValue(value: unknown, display: OverlayMapping['display']): string {
  const rendered = String(value);
  return typeof display?.template === 'string'
    ? display.template.split('{value}').join(rendered)
    : rendered;
}

export function applyOverlayMappings(base: unknown, overlayRaw: unknown, mappings: OverlayMapping[]): unknown {
  if (!isRecord(base) || !Array.isArray(base.records) || mappings.length === 0) return base;
  if (!isRecord(overlayRaw) || !Array.isArray(overlayRaw.records) || overlayRaw.records.length === 0) return base;
  const sourceRecord = overlayRaw.records.find(isRecord);
  if (!sourceRecord) return base;
  const patches = new Map<string, Record<string, unknown>>();
  for (const mapping of mappings) {
    const value = pickPath(sourceRecord, mapping.from.path);
    if (value === null || value === undefined || !passesGate(value, mapping.visibleWhen)) continue;
    const patch = patches.get(mapping.to.row_id) ?? {};
    patch[mapping.to.field] = formatOverlayValue(value, mapping.display);
    patches.set(mapping.to.row_id, patch);
  }
  if (patches.size === 0) return base;
  return {
    ...base,
    records: base.records.map((row) => {
      if (!isRecord(row)) return row;
      const patch = patches.get(String(row.id));
      if (!patch) return row;
      return { ...row, fields: { ...(isRecord(row.fields) ? row.fields : {}), ...patch } };
    }),
  };
}

export function normalizeSurfaceSource(raw: unknown): ApeakSurfaceSource | null {
  if (!isRecord(raw)) return null;
  const view = normalizeView(raw.view);
  const records = Array.isArray(raw.records) ? raw.records.map(normalizeRow).filter((x): x is ApeakRow => x !== null) : [];
  if (!view) return null;
  return { view, records };
}

export function rowFieldValue(row: ApeakRow, field: ApeakField): unknown {
  for (const path of field.paths) {
    const value = pickPath(row, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

function rowMatchesWhere(row: ApeakRow, where: ApeakField['rowsWhere'], fieldsById: Map<string, ApeakField>): boolean {
  if (!where) return true;
  const selectorField = fieldsById.get(where.field);
  if (!selectorField) return false;
  const value = rowFieldValue(row, selectorField);
  if (where.equals !== undefined) return String(value) === String(where.equals);
  if (Array.isArray(where.in)) return where.in.map(String).includes(String(value));
  return true;
}

export function deriveSections(source: ApeakSurfaceSource): ApeakSection[] {
  const fieldsById = new Map(source.view.fields.map((field) => [field.id, field]));
  return source.view.fields
    .filter((field) => field.role)
    .map((field) => ({
      field,
      rows: source.records.filter((row) => rowMatchesWhere(row, field.rowsWhere, fieldsById)),
    }))
    .filter((section) => section.rows.length > 0);
}

export function buildActionsIndex(rows: readonly ApeakRow[]): Record<string, ApeakAction> {
  const index: Record<string, ApeakAction> = Object.create(null);
  for (const row of rows) {
    for (const action of row.actions) index[action.id] = action;
  }
  return index;
}

export function mergeActionValues(action: ApeakAction, values?: MountActionValues): { target: string; payload: Record<string, unknown> } {
  const payload: Record<string, unknown> = {
    operation: action.operation ?? 'execute_definition',
    ...(action.definitionId ? { definitionId: action.definitionId, definition_id: action.definitionId } : {}),
    ...(action.input ? { input: action.input } : {}),
  };
  if (values?.request_id) payload.correlation_id = values.request_id;
  if (values?.fields) {
    const currentInput = isRecord(payload.input) ? payload.input : {};
    const currentFields = isRecord(currentInput.fields) ? currentInput.fields : {};
    payload.input = {
      ...currentInput,
      fields: {
        ...currentFields,
        ...values.fields,
      },
    };
  }
  return { target: action.target, payload };
}

export function mergeMeasuredFields(summary: SessionSummary): MountActionValues {
  const capturedFields: Record<string, unknown> = {};
  for (const capture of summary.captures) capturedFields[capture.fieldId] = capture.value;
  return {
    request_id: summary.sessionId,
    fields: {
      ...capturedFields,
      session_id: summary.sessionId,
      steps_total: summary.stepsTotal,
      steps_completed: summary.stepsCompleted,
      planned_seconds: summary.plannedSeconds,
      actual_seconds: Math.round(summary.actualSeconds * 10) / 10,
      step_captures: summary.captures.map(({ stepId, fieldId, value }) => ({ stepId, fieldId, value })),
      visibility_lost: summary.visibilityLost,
    },
  };
}

export function readAdvanceCondition(row: ApeakRow, field: ApeakField | undefined): AdvanceCondition | undefined {
  if (!field) return undefined;
  const raw = rowFieldValue(row, field);
  return isRecord(raw) && readText(raw.op) ? { op: String(raw.op), ...(isRecord(raw.args) ? { args: raw.args } : {}) } : undefined;
}
