export interface ProjectionRow {
  id: string;
  fields: Record<string, unknown>;
  proof?: Record<string, unknown>;
}

export interface ProjectionGroup {
  id: string;
  label: string;
  buckets: Array<{ key: string; label: unknown; row_ids: string[] }>;
}

export interface OwnerActionHandoff {
  id: string;
  owner_action_ref: string;
  label: string;
  enabled: boolean;
  input: Record<string, unknown>;
  row_id: string;
}

export interface ProjectionFeed {
  status: string;
  revision?: string | null;
  rows: ProjectionRow[];
  groups: ProjectionGroup[];
  actions: OwnerActionHandoff[];
  diagnostics?: { items: Array<{ code: string }> };
}

export function projectRecords(sourceRecords: unknown, lens: Record<string, unknown>, options?: Record<string, unknown>): ProjectionFeed;
export function projectOwnerActionHandoffs(rows: ProjectionRow[], handoffSpecs?: Array<Record<string, unknown>>): OwnerActionHandoff[];
export function projectContextFeed(sourceRecords: unknown, lens: Record<string, unknown>, options?: Record<string, unknown>): ProjectionFeed;
