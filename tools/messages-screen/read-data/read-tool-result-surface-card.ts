// PORTED FROM: bitfield-packages/packages/chat/read-data/read-tool-result-surface-card.ts @ e99ac5976
import type { PlaceableSurfacePayload } from '../../ui/show/placeable-surface-intent';

export interface ToolResultCount {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

export interface ToolResultSurfaceSummary {
  readonly surfaceRef: string;
  readonly counts: readonly ToolResultCount[];
  readonly rowCount: number | null;
  readonly rows: readonly Record<string, unknown>[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readableLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : key;
}

function readCounts(value: unknown): ToolResultCount[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, raw]) => (
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
      ? [{ key, label: readableLabel(key), value: raw }]
      : []
  ));
}

function readRows(value: Record<string, unknown>): readonly Record<string, unknown>[] | null {
  for (const key of ['rows', 'records', 'items']) {
    if (Array.isArray(value[key])) return value[key].filter(isRecord);
  }
  return null;
}

/**
 * Read the generic result-card contract selected by trusted action DATA. The
 * surface reference is only an identity hint. The current catalog supplies the
 * mount contract and remains the authority for whether the surface can open.
 */
export function readToolResultSurfaceSummary(value: unknown): ToolResultSurfaceSummary | null {
  if (!isRecord(value)) return null;
  const surfaceRef = nonEmptyString(value.surface_ref) ?? nonEmptyString(value.surfaceRef);
  const hasCounts = isRecord(value.counts);
  const rows = readRows(value);
  if (!surfaceRef || (!hasCounts && rows === null)) return null;
  return {
    surfaceRef,
    counts: readCounts(value.counts),
    rowCount: rows?.length ?? null,
    rows,
  };
}

export function findToolResultSurface(
  summary: ToolResultSurfaceSummary | null,
  catalog: readonly PlaceableSurfacePayload[],
): PlaceableSurfacePayload | null {
  if (!summary) return null;
  return catalog.find((surface) => surface.id === summary.surfaceRef) ?? null;
}

/** Keep the current catalog payload authoritative and overlay only result rows. */
export function toolResultSurfaceWithRows(
  surface: PlaceableSurfacePayload,
  summary: ToolResultSurfaceSummary,
): PlaceableSurfacePayload {
  if (summary.rows === null) return surface;
  return {
    ...surface,
    surfaceInput: {
      ...(surface.surfaceInput ?? {}),
      records: [...summary.rows],
    },
  };
}
