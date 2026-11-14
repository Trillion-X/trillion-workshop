// packages/sync-status/read-data/read-sync-status.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure descriptor-projection decoding for the sync-status surface.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Readers consume descriptor-projected row objects only
// 2. Canonical ownership remains in source facts; this file only sees projections
// 3. Feed decoding is pure and caller-agnostic; no byte or owner-row parsing lives here
//
// =============================================================================

export interface SyncStatusRecord {
  lastSync?: string;
  filesUpdated: number;
  errors: string[];
}

export interface ManagedProjectRecord {
  path: string;
}

export interface SyncStatusFeed {
  status: SyncStatusRecord;
  projects: ManagedProjectRecord[];
}

interface SyncStatusRow {
  lastSync?: unknown;
  filesUpdated?: unknown;
  errors?: unknown;
}

interface ManagedProjectRow {
  path?: unknown;
}

function coerceNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function firstObject(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};
  const row = value.find((entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry));
  return row ? row as Record<string, unknown> : {};
}

function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function decodeProjects(value: unknown): ManagedProjectRecord[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is ManagedProjectRow => !!entry && typeof entry === 'object' && !Array.isArray(entry))
        .map((entry) => ({ path: typeof entry.path === 'string' ? entry.path : '' }))
        .filter((entry) => entry.path.length > 0)
    : [];
}

export function decodeSyncStatusFeed(
  statusRows: unknown,
  projectRows: unknown,
): SyncStatusFeed {
  const status = firstObject(statusRows) as SyncStatusRow;

  return {
    status: {
      lastSync: typeof status.lastSync === 'string' ? status.lastSync : undefined,
      filesUpdated: coerceNumber(status.filesUpdated),
      errors: coerceStringArray(status.errors),
    },
    projects: decodeProjects(projectRows),
  };
}
