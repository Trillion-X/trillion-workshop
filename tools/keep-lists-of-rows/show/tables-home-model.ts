//
// Pure model for the Tables home surface: which published records ARE tables,
// and what DATA row a new table becomes. No React, no I/O — the surface and
// the tests consume the same functions.
//
// A "table" is not an enum membership: it is any placeable-surface record this
// package published that carries its own field descriptors (surface_input
// fields). The filter is structural (L090) — a new table-config row appears in
// the catalog with zero code change here.

import {
  readPlaceableSurfaces,
  type PlaceableSurfaceRecord,
} from '@/packages/ui';

export interface TableCatalogEntry {
  surface: PlaceableSurfaceRecord;
  fieldCount: number;
  viewCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function descriptorCount(surfaceInput: Record<string, unknown> | undefined, key: 'fields' | 'views'): number {
  if (!surfaceInput) return 0;
  const block = surfaceInput[key];
  if (!isRecord(block)) return 0;
  const list = key === 'fields' ? block.descriptors : block.views;
  return Array.isArray(list) ? list.length : 0;
}

/** All tables this package published, from the shared records feed. */
export function readTableCatalog(recordsRaw: unknown, packageName: string): readonly TableCatalogEntry[] {
  return readPlaceableSurfaces(recordsRaw)
    .filter((surface) =>
      surface.packageEntry?.packageName === packageName
      && descriptorCount(surface.surfaceInput, 'fields') > 0)
    .map((surface) => ({
      surface,
      fieldCount: descriptorCount(surface.surfaceInput, 'fields'),
      viewCount: descriptorCount(surface.surfaceInput, 'views'),
    }))
    .sort((left, right) => left.surface.label.localeCompare(right.surface.label));
}

export function tableSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export interface NewTableWrite {
  addressLabel: string;
  payload: Record<string, unknown>;
}

/** The DATA row a new table becomes: one placeable-surface record with its own
 *  field descriptors and one kind-filtered table view — the exact shape the 36
 *  authored table-configs use, so a created table and an authored one are the
 *  same thing. Honest-empty (L117): title + kind starter fields only; the user
 *  grows the schema with + Field on the open board. */
export function buildNewTableWrite(
  name: string,
  catalog: readonly TableCatalogEntry[],
  packageName: string,
  entryName: string,
): NewTableWrite | null {
  const label = name.trim();
  const baseSlug = tableSlug(label);
  if (!label || !baseSlug) return null;
  const takenIds = new Set(catalog.map((entry) => entry.surface.id));
  let slug = baseSlug;
  for (let suffix = 2; takenIds.has(`visual-database.table.${slug}`); suffix += 1) {
    slug = `${baseSlug}-${suffix}`;
  }
  const order = 400 + catalog.length;
  return {
    addressLabel: `package::visual-database::table-config::${slug}`,
    payload: {
      kind: 'placeable-surface',
      id: `visual-database.table.${slug}`,
      surface_id: `visual-database.table.${slug}`,
      label,
      icon: 'Table',
      order,
      // Field-bearing Visual Database surfaces already belong to the Tables
      // catalog. Top-level workspace placement is an explicit, separate choice.
      placement_labels: [],
      placement_order_key: `000000${order}:visual-database.table.${slug}`,
      material_target: 'component:visual-database',
      package_entry: { entry_name: entryName, package_name: packageName },
      factflow_ref: 'package::visual-database::factflow::surface',
      surface_input: {
        fields: {
          kind: 'visual-database.fields',
          version: 2,
          descriptors: [
            {
              id: 'title',
              label: 'Title',
              role: 'title',
              paths: [['payload', 'title'], ['title']],
              writePath: ['payload', 'title'],
            },
            { id: 'kind', label: 'Kind', role: 'kind', paths: [['kind'], ['payload', 'kind']] },
          ],
        },
        views: {
          views: [
            {
              id: `${slug}-table`,
              label,
              kind: 'table',
              order: 10,
              filters: [{ field: 'kind', equals: [slug], exclude: [] }],
              projectionRules: [],
            },
          ],
        },
        actions: { actions: [] },
      },
    },
  };
}

/** The intent payload that opens a catalog table as a tab. */
export function openTablePayload(surface: PlaceableSurfaceRecord): {
  id: string;
  title: string;
  icon?: string;
  materialTarget: string;
  packageEntry?: { packageName: string; entryName: string };
  surfaceInput?: Record<string, unknown>;
} {
  return {
    id: surface.id,
    title: surface.label,
    ...(surface.icon ? { icon: surface.icon } : {}),
    materialTarget: surface.materialTarget,
    ...(surface.packageEntry ? { packageEntry: surface.packageEntry } : {}),
    ...(surface.surfaceInput ? { surfaceInput: surface.surfaceInput } : {}),
  };
}
