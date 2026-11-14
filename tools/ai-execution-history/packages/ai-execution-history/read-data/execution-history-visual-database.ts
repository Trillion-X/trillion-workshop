import {
  decodeVisualDatabaseEvaluatorDescriptors,
  decodeVisualDatabaseFields,
  decodeVisualDatabaseModel,
  type VisualDatabaseEvaluatorDescriptor,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseModel,
} from '@/packages/visual-database/read-data/visual-database';
import {
  resolutionInputsForFoldedCells,
  resolveAddressedCells,
  type AddressedCellInput,
  type DeriveDispatch,
} from '@/packages/visual-database/do-work/resolve-derived-fields';
import {
  readExecutionHistory,
  type PublishedRecord,
} from '@/packages/ai-execution-history/read-data/read-ai-execution-history';

type ProjectedExecutionRunRow = {
  address: string;
  payload: Record<string, unknown>;
};

export interface ExecutionHistoryVisualDatabaseProjection {
  initialViewId?: string;
  model: VisualDatabaseModel;
  evaluatorDescriptors: readonly VisualDatabaseEvaluatorDescriptor[];
}

interface ExecutionHistoryVisualDatabaseSurfaceInput {
  initialViewId?: string;
  evaluatorDescriptors: unknown;
  fields: unknown;
  views: unknown;
  feedInputName?: string;
  recordShape: string;
}

const PATH_PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rowsFromFeed(feed: unknown): readonly unknown[] {
  if (Array.isArray(feed)) return feed;
  if (!isRecord(feed)) return [];
  for (const key of ['rows', 'records', 'items']) {
    if (Array.isArray(feed[key])) return feed[key] as unknown[];
  }
  return [];
}

function publishedRecordsFromFeed(feed: unknown): PublishedRecord[] {
  return rowsFromFeed(feed).map((row) => {
    if (!isRecord(row)) return { payload: row };
    return { payload: Object.prototype.hasOwnProperty.call(row, 'payload') ? row.payload : row };
  });
}

function rawRunRowsById(feed: unknown): ReadonlyMap<string, { address?: string; payload: Record<string, unknown> }> {
  const byId = new Map<string, { address?: string; payload: Record<string, unknown> }>();
  for (const row of rowsFromFeed(feed)) {
    if (!isRecord(row) || !isRecord(row.payload) || row.payload.kind !== 'ai-execution-run') continue;
    const id = text(row.payload.id);
    if (!id) continue;
    byId.set(id, {
      ...(text(row.address) ? { address: row.address as string } : {}),
      payload: row.payload,
    });
  }
  return byId;
}

function readExecutionHistoryVisualDatabaseSurfaceInput(
  raw: unknown,
): ExecutionHistoryVisualDatabaseSurfaceInput | null {
  if (!isRecord(raw) || raw.surfaceKind !== 'visual-database') return null;
  const recordShape = text(raw.recordShape ?? raw.record_shape) ?? 'execution-runs';
  return {
    initialViewId: text(raw.initialViewId ?? raw.initial_view_id),
    evaluatorDescriptors: raw.evaluatorDescriptors ?? raw.evaluator_descriptors ?? [],
    fields: raw.fields ?? null,
    views: raw.views ?? null,
    feedInputName: text(raw.feedInputName ?? raw.feed_input_name),
    recordShape,
  };
}

export function readExecutionHistoryVisualDatabaseFeedInputName(surfaceInput: unknown): string | null {
  return readExecutionHistoryVisualDatabaseSurfaceInput(surfaceInput)?.feedInputName ?? null;
}

function listStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter((entry): entry is string => !!entry);
  const one = text(value);
  return one ? [one] : [];
}

function evidenceSummary(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const provenance = isRecord(payload.provenance) ? payload.provenance : null;
  if (!provenance) return undefined;
  const refs = listStrings(provenance.source_artifact_refs);
  if (refs.length > 0) return refs.join(', ');
  const confidence = numeric(provenance.confidence);
  return confidence == null ? undefined : `${Math.round(confidence * 100)}% confidence`;
}

function artifactSummary(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const outcome = isRecord(payload.outcome) ? payload.outcome : null;
  if (!outcome) return undefined;
  const refs = listStrings(outcome.result_refs);
  return refs.length > 0 ? refs.join(', ') : undefined;
}

function projectedExecutionRunRows(feed: unknown): readonly ProjectedExecutionRunRow[] {
  const history = readExecutionHistory(publishedRecordsFromFeed(feed));
  const rawById = rawRunRowsById(feed);
  return history.runs.map((run, index) => {
    const raw = rawById.get(run.id);
    const payload = raw?.payload;
    const evidence = evidenceSummary(payload);
    const artifact = artifactSummary(payload);
    return {
      address: raw?.address ?? `package::ai-execution-history::visual-database::${run.id || index}`,
      payload: {
        id: run.id,
        ...(run.objective ? { objective: run.objective } : {}),
        ...(text(payload?.label) ? { label: payload?.label as string } : {}),
        ...(text(payload?.agent_label) ? { agent_label: payload?.agent_label as string } : {}),
        ...(run.agent_ref ? { agent_ref: run.agent_ref } : {}),
        ...(run.started_at ? { started_at: run.started_at } : {}),
        ...(run.ended_at ? { ended_at: run.ended_at } : {}),
        ...(run.status ? { status: run.status } : {}),
        ...(run.total_cost == null ? {} : { total_cost: run.total_cost }),
        ...(run.total_units == null ? {} : { total_units: run.total_units }),
        ...(evidence ? { evidence_source: evidence } : {}),
        ...(artifact ? { artifact_link: artifact } : {}),
      },
    };
  });
}

function projectedGenericRows(feed: unknown): readonly ProjectedExecutionRunRow[] {
  return rowsFromFeed(feed).map((row, index) => {
    const rowRecord = isRecord(row) ? row : null;
    const rawPayload =
      rowRecord && Object.prototype.hasOwnProperty.call(rowRecord, 'payload') ? rowRecord.payload : row;
    const payload = isRecord(rawPayload) ? rawPayload : { value: rawPayload };
    const address =
      (rowRecord ? text(rowRecord.address) : undefined) ??
      text(payload.id) ??
      `package::ai-execution-history::visual-database::row-${index}`;
    return { address, payload };
  });
}

function readPathValue(source: unknown, path: readonly string[]): unknown {
  let current = source;
  for (const part of path) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function firstFieldValue(row: ProjectedExecutionRunRow, field: VisualDatabaseFieldDescriptor): unknown {
  for (const path of field.paths) {
    const value = readPathValue(row, path);
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function recordRefForRow(row: ProjectedExecutionRunRow, index: number): string {
  return text(row.address) ?? text(row.payload.id) ?? `execution-history-row-${index}`;
}

function cloneRow(row: ProjectedExecutionRunRow): ProjectedExecutionRunRow {
  return structuredClone(row);
}

function writePathForField(field: VisualDatabaseFieldDescriptor): readonly string[] | null {
  if (field.writePath && field.writePath.length > 0) return field.writePath;
  return field.paths[0]?.length ? field.paths[0]! : null;
}

function setPathValue(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  if (path.length === 0 || path.some((segment) => PATH_PROTOTYPE_KEYS.has(segment))) return;
  let current: unknown = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    if (!isRecord(current)) return;
    const existing = current[segment];
    if (!isRecord(existing)) current[segment] = {};
    current = current[segment];
  }
  if (!isRecord(current)) return;
  current[path[path.length - 1]!] = value;
}

async function materializeDerivedRows(
  rows: readonly ProjectedExecutionRunRow[],
  fields: readonly VisualDatabaseFieldDescriptor[],
  evaluators: readonly VisualDatabaseEvaluatorDescriptor[],
  dispatch: DeriveDispatch,
): Promise<readonly ProjectedExecutionRunRow[]> {
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const defaults: AddressedCellInput[] = rows.flatMap((row, index) => {
    const recordRef = recordRefForRow(row, index);
    return fields.map((field) => ({
      cellRef: { recordRef, fieldRef: field.id },
      expression: field.defaultExpression
        ? field.defaultExpression
        : { literal: firstFieldValue(row, field) },
    }));
  });
  if (!defaults.some((cell) => cell.expression.derive)) return rows;
  const resolution = await resolveAddressedCells(
    resolutionInputsForFoldedCells([], defaults),
    dispatch,
    undefined,
    evaluators,
  );
  const clonedRows = rows.map(cloneRow);
  const rowByRef = new Map(clonedRows.map((row, index) => [recordRefForRow(row, index), row]));
  for (const resolved of resolution.cells.values()) {
    const field = fieldById.get(resolved.cellRef.fieldRef);
    if (!field?.defaultExpression?.derive || resolved.error || resolved.value === undefined) continue;
    const row = rowByRef.get(resolved.cellRef.recordRef);
    const writePath = writePathForField(field);
    if (!row || !writePath) continue;
    setPathValue(row, writePath, resolved.value);
  }
  return clonedRows;
}

export async function buildExecutionHistoryVisualDatabaseProjection(
  surfaceInput: unknown,
  feed: unknown,
  dispatch: DeriveDispatch,
): Promise<ExecutionHistoryVisualDatabaseProjection | null> {
  const decoded = readExecutionHistoryVisualDatabaseSurfaceInput(surfaceInput);
  if (!decoded) return null;
  const fields = decodeVisualDatabaseFields(decoded.fields);
  const evaluatorDescriptors = decodeVisualDatabaseEvaluatorDescriptors(decoded.evaluatorDescriptors);
  const baseRows =
    decoded.recordShape === 'execution-runs'
      ? projectedExecutionRunRows(feed)
      : projectedGenericRows(feed);
  const rows = await materializeDerivedRows(
    baseRows,
    fields,
    evaluatorDescriptors,
    dispatch,
  );
  return {
    ...(decoded.initialViewId ? { initialViewId: decoded.initialViewId } : {}),
    evaluatorDescriptors,
    model: decodeVisualDatabaseModel({
      records: { rows },
      fields: decoded.fields,
      views: decoded.views,
      actions: null,
    }),
  };
}
