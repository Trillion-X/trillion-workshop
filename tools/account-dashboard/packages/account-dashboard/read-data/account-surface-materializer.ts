import type {
  JsonRecord,
  SurfaceAction,
  SurfaceDescriptorSet,
  SurfaceDiagnostic,
  SurfaceField,
  SurfaceFieldDescriptor,
  SurfaceFreshness,
  SurfaceModel,
  SurfaceSourceRow,
} from './account-surface-model';

export interface ReadSurfaceModelInput {
  descriptors?: SurfaceDescriptorSet | null;
  rows?: readonly SurfaceSourceRow[] | null;
  loading?: boolean;
  error?: string | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function textValue(value: unknown, empty = ''): string {
  if (value == null || value === '') return empty;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function matches(row: unknown, match?: JsonRecord): boolean {
  if (!match) return true;
  if (!isRecord(row)) return false;
  return Object.entries(match).every(([key, expected]) => {
    const actual = row[key];
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });
}

function sourceRows(rows: readonly SurfaceSourceRow[], sourceId?: string): readonly unknown[] {
  if (!sourceId) return rows;
  const source = rows.find((row) => row.sourceId === sourceId);
  if (!source) return [];
  if (source.rows) return source.rows;
  return source.data === undefined ? [] : [source.data];
}

function sourceSubject(rows: readonly SurfaceSourceRow[], sourceId?: string): string | undefined {
  if (!sourceId) return undefined;
  const source = rows.find((row) => row.sourceId === sourceId);
  return source?.subject;
}

function readFieldValue(
  descriptor: SurfaceFieldDescriptor,
  rows: readonly SurfaceSourceRow[],
): unknown {
  const subject = sourceSubject(rows, descriptor.source);
  if (subject) {
    for (const path of descriptor.paths ?? []) {
      if (path.length === 1 && path[0] === 'subject') return subject;
    }
  }
  for (const row of sourceRows(rows, descriptor.source)) {
    if (!matches(row, descriptor.match)) continue;
    for (const path of descriptor.paths ?? []) {
      const value = readPath(row, path);
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

function materializeField(
  descriptor: SurfaceFieldDescriptor,
  rows: readonly SurfaceSourceRow[],
): SurfaceField {
  const value = readFieldValue(descriptor, rows);
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    label: descriptor.label,
    value: value ?? null,
    text: textValue(value, descriptor.empty ?? ''),
    priority: descriptor.priority ?? 100,
    sourceId: descriptor.source,
  };
}

function materializeAction(action: NonNullable<SurfaceDescriptorSet['actions']>[number]): SurfaceAction {
  return {
    id: action.id,
    slot: action.slot,
    label: action.label,
    locus: action.locus ?? 'workflow',
    target: action.target,
    operation: action.operation,
    definitionId: action.definitionId,
    payload: action.payload,
    input: action.input,
    copy: action.copy ?? [],
    disabled: Boolean(action.disabledReason),
    disabledReason: action.disabledReason,
    successPath: action.successPath,
  };
}

function diagnostics(rows: readonly SurfaceSourceRow[]): SurfaceDiagnostic[] {
  return rows
    .filter((row) => row.error)
    .map((row) => ({
      code: 'source-error',
      message: row.error ?? 'Source failed.',
      sourceId: row.sourceId,
    }));
}

function freshness(descriptors?: SurfaceDescriptorSet | null): SurfaceFreshness {
  return {
    id: descriptors?.freshness?.id ?? 'freshness',
    label: descriptors?.freshness?.label ?? 'Freshness',
    state: descriptors?.freshness?.state ?? 'unknown',
  };
}

export function readSurfaceModel(input: ReadSurfaceModelInput = {}): SurfaceModel {
  const descriptors = input.descriptors ?? {};
  const rows = input.rows ?? [];
  const descriptorCount =
    (descriptors.sources?.length ?? 0)
    + (descriptors.fields?.length ?? 0)
    + (descriptors.actions?.length ?? 0);

  if (input.loading) {
    return {
      state: 'loading',
      fields: [],
      actions: [],
      freshness: freshness(descriptors),
      diagnostics: [],
      relationships: [...(descriptors.relationships ?? [])],
      fixtures: (descriptors.fixtures ?? []).map((id) => ({ id })),
      proof: { descriptorCount, sourceRowCount: rows.length },
    };
  }

  if (input.error) {
    return {
      state: 'error',
      fields: [],
      actions: (descriptors.actions ?? []).map(materializeAction),
      freshness: freshness(descriptors),
      diagnostics: [{ code: 'read-error', message: input.error }],
      relationships: [...(descriptors.relationships ?? [])],
      fixtures: (descriptors.fixtures ?? []).map((id) => ({ id })),
      proof: { descriptorCount, sourceRowCount: rows.length },
    };
  }

  const fields = (descriptors.fields ?? [])
    .map((field) => materializeField(field, rows))
    .sort((a, b) => a.priority - b.priority);
  const hasSubject = fields.some((field) => field.kind === 'subject' && field.value != null && field.text.trim());

  return {
    state: hasSubject ? 'ready' : 'empty',
    fields,
    actions: (descriptors.actions ?? []).map(materializeAction),
    freshness: freshness(descriptors),
    diagnostics: diagnostics(rows),
    relationships: [...(descriptors.relationships ?? [])],
    fixtures: (descriptors.fixtures ?? []).map((id) => ({ id })),
    proof: { descriptorCount, sourceRowCount: rows.length },
  };
}
