import {
  decodeVisualDatabaseEvaluatorDescriptors,
  decodeVisualDatabaseFields,
  decodeVisualDatabaseModel,
  type VisualDatabaseEvaluatorDescriptor,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseModel,
} from '../../keep-lists-of-rows/read-data/visual-database';
import {
  resolutionInputsForFoldedCells,
  resolveAddressedCells,
  type AddressedCellInput,
  type DeriveDispatch,
} from '../../keep-lists-of-rows/do-work/resolve-derived-fields';

export interface FounderGrowthVisualDatabaseProjection {
  initialViewId?: string;
  model: VisualDatabaseModel;
  evaluatorDescriptors: readonly VisualDatabaseEvaluatorDescriptor[];
  openRows?: {
    intentPath: readonly string[];
    allowList: readonly Readonly<Record<string, unknown>>[];
  };
}

interface SurfaceInput {
  initialViewId?: string;
  feedInputName: string;
  fields: unknown;
  views: unknown;
  evaluatorDescriptors: unknown;
  openRows?: unknown;
}

const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readSurfaceInput(raw: unknown): SurfaceInput | null {
  if (!isRecord(raw) || raw.surfaceKind !== 'visual-database') return null;
  const feedInputName = text(raw.feedInputName ?? raw.feed_input_name);
  if (!feedInputName) return null;
  return {
    feedInputName,
    initialViewId: text(raw.initialViewId ?? raw.initial_view_id),
    fields: raw.fields,
    views: raw.views,
    evaluatorDescriptors: raw.evaluatorDescriptors ?? raw.evaluator_descriptors ?? [],
    openRows: raw.openRows ?? raw.open_rows,
  };
}

export function readFounderGrowthFeedInputName(raw: unknown): string | null {
  return readSurfaceInput(raw)?.feedInputName ?? null;
}

function rowsFromFeed(feed: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(feed)
    ? feed
    : isRecord(feed) && Array.isArray(feed.rows)
      ? feed.rows
      : isRecord(feed) && Array.isArray(feed.records)
        ? feed.records
        : isRecord(feed) && Array.isArray(feed.items)
          ? feed.items
          : [];
  return rows.filter(isRecord).map((row) => structuredClone(row));
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function firstFieldValue(row: Record<string, unknown>, field: VisualDatabaseFieldDescriptor): unknown {
  for (const path of field.paths) {
    const value = readPath(row, path);
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function recordRef(row: Record<string, unknown>, index: number): string {
  const source = isRecord(row.record) ? row.record : row;
  const payload = isRecord(row.payload) ? row.payload : null;
  return text(source.address) ?? text(payload?.id) ?? `founder-growth-row-${index}`;
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  if (path.length === 0 || path.some((segment) => PROTOTYPE_KEYS.has(segment))) return;
  let current = target;
  for (const segment of path.slice(0, -1)) {
    if (!isRecord(current[segment])) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = value;
}

async function materializeDerivedRows(
  rows: readonly Record<string, unknown>[],
  fields: readonly VisualDatabaseFieldDescriptor[],
  evaluators: readonly VisualDatabaseEvaluatorDescriptor[],
  dispatch: DeriveDispatch,
): Promise<readonly Record<string, unknown>[]> {
  const defaults: AddressedCellInput[] = rows.flatMap((row, index) => fields.map((field) => ({
    cellRef: { recordRef: recordRef(row, index), fieldRef: field.id },
    expression: field.defaultExpression ?? { literal: firstFieldValue(row, field) },
  })));
  if (!defaults.some((cell) => cell.expression.derive)) return rows;
  const resolved = await resolveAddressedCells(
    resolutionInputsForFoldedCells([], defaults),
    dispatch,
    undefined,
    evaluators,
  );
  const output = rows.map((row) => structuredClone(row));
  const rowByRef = new Map(output.map((row, index) => [recordRef(row, index), row]));
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  for (const cell of resolved.cells.values()) {
    const field = fieldById.get(cell.cellRef.fieldRef);
    const row = rowByRef.get(cell.cellRef.recordRef);
    const path = field?.writePath ?? field?.paths[0];
    if (!field?.defaultExpression?.derive || !row || !path || cell.error || cell.value === undefined) continue;
    setPath(row, path, cell.value);
  }
  return output;
}

function readOpenRows(value: unknown): FounderGrowthVisualDatabaseProjection['openRows'] {
  if (!isRecord(value) || !Array.isArray(value.intentPath) || !Array.isArray(value.allowList)) return undefined;
  const intentPath = value.intentPath.filter((segment): segment is string => typeof segment === 'string');
  const allowList = value.allowList.filter(isRecord);
  return intentPath.length === value.intentPath.length && intentPath.length > 0
    ? { intentPath, allowList }
    : undefined;
}

export async function buildFounderGrowthVisualDatabaseProjection(
  surfaceInput: unknown,
  feed: unknown,
  dispatch: DeriveDispatch,
): Promise<FounderGrowthVisualDatabaseProjection | null> {
  const decoded = readSurfaceInput(surfaceInput);
  if (!decoded) return null;
  const fields = decodeVisualDatabaseFields(decoded.fields);
  const evaluatorDescriptors = decodeVisualDatabaseEvaluatorDescriptors(decoded.evaluatorDescriptors);
  const rows = await materializeDerivedRows(rowsFromFeed(feed), fields, evaluatorDescriptors, dispatch);
  return {
    ...(decoded.initialViewId ? { initialViewId: decoded.initialViewId } : {}),
    ...(readOpenRows(decoded.openRows) ? { openRows: readOpenRows(decoded.openRows) } : {}),
    evaluatorDescriptors,
    model: decodeVisualDatabaseModel({
      records: { rows },
      fields: decoded.fields,
      views: decoded.views,
      actions: { actions: [] },
    }),
  };
}
