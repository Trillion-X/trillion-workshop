// packages/motion-analysis/read-data/read-capture-context.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure reads for the SwingVision capture→stats surface: pull the perception
// TrackerDescriptor (DATA), the match-stats view DATA, and the
// emitted match-stat record out of the live published-record stream — and build
// the per-mount `surfaceInput` the inline visual-database renders. No React, no I/O,
// no dispatch: the mount calls these in `useMemo` so the surface stays props-
// only and these stay unit-testable. The generic package names NO machine path,
// NO model, NO sport — every Society value (orchestrator path, env, stat labels)
// rides the DATA records read here (Physics vs Society / L089/L090).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { TrackerDescriptor } from '../do-work/submit-motion-analysis.ts';

export type CaptureRow = Record<string, unknown>;

/** Normalize whatever a live input hands back into a flat row list, so the
 *  readers below work whether the surface reads the whole published-record
 *  stream OR a single targeted address. Accepts: an array of record payloads, a
 *  `{records:[...]}` carrier, or a single record payload (an object carrying a
 *  `kind`). Anything else → `[]` (honest empty, never a throw). */
export function captureRows(raw: unknown): CaptureRow[] {
  if (Array.isArray(raw)) return raw as CaptureRow[];
  if (raw && typeof raw === 'object') {
    const obj = raw as { records?: unknown; kind?: unknown };
    if (Array.isArray(obj.records)) return obj.records as CaptureRow[];
    if (typeof obj.kind === 'string') return [raw as CaptureRow];
  }
  return [];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const isRow = (v: unknown): v is CaptureRow => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read the perception TrackerDescriptor DATA (deployment-supplied) by id. Returns
 *  null when absent or missing the required orchestrator/tracker identity, so the
 *  caller fails closed (never dispatches perception with an incomplete runner). */
export function readTrackerDescriptor(raw: unknown, trackerId: string): TrackerDescriptor | null {
  const row = captureRows(raw).find((r) => r.kind === 'tracker-descriptor' && r.id === trackerId);
  if (!row) return null;
  const orchestratorPath = str(row.orchestratorPath);
  const tid = str(row.trackerId);
  if (!orchestratorPath || !tid) return null;
  return {
    trackerId: tid,
    orchestratorPath,
    checkpointPath: str(row.checkpointPath),
    maxFrames: num(row.maxFrames),
    timeoutMs: num(row.timeoutMs),
    env: isRow(row.env) ? (row.env as Record<string, string>) : undefined,
  };
}

/** Read the match-stats view DATA by id (the panel definition). */
export function readMatchStatsView(raw: unknown, viewId: string): unknown | null {
  const row = captureRows(raw).find((r) => r.kind === 'match-stats-view' && r.id === viewId);
  return row && 'view' in row ? row.view : null;
}

/** Find the emitted match-stat record for one capture session (by its stat id).
 *  This is how the surface knows the run finished — the record is the SSOT, not
 *  the workflow response. */
export function findMatchStat(raw: unknown, statId: string): CaptureRow | null {
  return captureRows(raw).find((r) => r.kind === 'match-stat' && r.id === statId) ?? null;
}

type MatchStatsField = {
  id?: unknown;
  label?: unknown;
  role?: unknown;
  path?: unknown;
  paths?: unknown;
  format?: unknown;
};

function matchStatsFields(view: unknown): MatchStatsField[] {
  if (!isRow(view) || !Array.isArray(view.fields)) return [];
  return view.fields.filter(isRow) as MatchStatsField[];
}

function fieldId(field: MatchStatsField): string | null {
  return str(field.id) ?? null;
}

function fieldLabel(field: MatchStatsField): string {
  return str(field.label) ?? fieldId(field) ?? 'Value';
}

function fieldPaths(field: MatchStatsField): string[][] {
  if (Array.isArray(field.paths)) {
    const paths = field.paths.filter(
      (path): path is string[] => Array.isArray(path) && path.every((part) => typeof part === 'string'),
    );
    if (paths.length > 0) return paths;
  }
  if (Array.isArray(field.path) && field.path.every((part) => typeof part === 'string')) {
    return [field.path as string[]];
  }
  const id = fieldId(field);
  return id ? [['fields', id]] : [];
}

function metricFormat(field: MatchStatsField): string {
  if (!isRow(field.format)) return 'decimal';
  if (field.format.style === 'percent') return 'percent';
  return field.format.maximumFractionDigits === 0 ? 'integer' : 'decimal';
}

/** Build the inline-result `surfaceInput` for visual-database. The first view is
 *  a metric strip over every scalar match-stat field; the second is a complete
 *  table so non-scalar fields such as placement heat remain available rather
 *  than being dropped during the repoint. Returns null until BOTH the view DATA
 *  and the session's match-stat exist. */
export function buildResultSurfaceInput(
  view: unknown,
  statRecord: CaptureRow | null,
): {
  records: CaptureRow[];
  fields: Record<string, unknown>;
  views: Record<string, unknown>;
  actions: Record<string, unknown>;
} | null {
  if (view === null || view === undefined || !statRecord) return null;
  const viewRecord = isRow(view) ? view : {};
  const fields = matchStatsFields(view);
  const descriptors = [
    { id: 'record-id', label: 'Match', role: 'id', paths: [['id'], ['payload', 'id']], editable: false },
    { id: 'record-title', label: 'Match', role: 'title', paths: [['label'], ['payload', 'label']], editable: false },
    ...fields.flatMap((field) => {
      const id = fieldId(field);
      const paths = fieldPaths(field);
      if (!id || paths.length === 0) return [];
      return [{
        id,
        label: fieldLabel(field),
        role: field.role === 'big-number' ? 'metric' : 'none',
        paths,
        editable: false,
      }];
    }),
  ];
  const metricValues = fields.flatMap((field) => {
    const id = fieldId(field);
    if (!id || field.role === 'placement-heat') return [];
    return [{
      id,
      label: fieldLabel(field),
      aggregation: { op: 'latest', fieldId: id },
      format: metricFormat(field),
    }];
  });
  const baseId = str(viewRecord.id) ?? 'match-stats';
  const label = str(viewRecord.label) ?? 'Match stats';
  const detailView = {
    id: `${baseId}.details`,
    label: 'Details',
    kind: 'table',
    order: metricValues.length > 0 ? 10 : 0,
    filters: [],
    projectionRules: [],
    columns: { order: fields.map(fieldId).filter((id): id is string => id !== null) },
  };
  const views = metricValues.length > 0
    ? [
        {
          id: `${baseId}.metrics`,
          label,
          kind: 'metric',
          order: 0,
          filters: [],
          projectionRules: [],
          metrics: [{ id: `${baseId}.summary`, atom: 'stat-strip', values: metricValues }],
        },
        detailView,
      ]
    : [detailView];
  return {
    records: [statRecord],
    fields: { kind: 'visual-database.fields', version: 3, descriptors },
    views: { kind: 'visual-database.views', version: 3, views },
    actions: { kind: 'visual-database.actions', version: 1, actions: [] },
  };
}
