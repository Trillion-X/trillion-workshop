// package://packages/item-record/read-data/read-home-rail.ts
//
// Decoders for the home feed's right rail: community summaries from the
// published `groups` input. This package owns its own decode (BRTK5016 —
// no source import from group-list); the published rows are the contract.

export interface RailGroup {
  groupRef: string;
  name: string;
  summary: string;
}

function isRow(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function rowsFrom(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw.filter(isRow);
  if (isRow(raw)) {
    for (const key of ['items', 'rows', 'records']) {
      const rows = raw[key];
      if (Array.isArray(rows)) return rows.filter(isRow);
    }
  }
  return [];
}

export function decodeRailGroups(raw: unknown): RailGroup[] {
  return rowsFrom(raw)
    .map((row) => ({
      groupRef: text(row.group_ref) || text(row.groupRef) || text(row.id),
      name: text(row.name) || text(row.title) || 'Untitled group',
      summary: text(row.summary) || text(row.description) || text(row.purpose),
    }))
    .filter((group) => group.groupRef.length > 0);
}
