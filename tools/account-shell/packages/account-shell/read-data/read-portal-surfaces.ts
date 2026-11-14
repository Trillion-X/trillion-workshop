// packages/account-shell/read-data/read-portal-surfaces.ts
//
// Decode the portal surface catalog rows into sidebar navigation sections.

export interface PortalSurface {
  id: string;
  label: string;
  description: string;
  materialTarget: string | null;
  target: string | null;
  order: number;
  sectionId: string;
  sectionLabel: string;
  showInNavigation: boolean;
  wrapMaterial: boolean;
  packageEntry: { packageName: string; entryName: string } | null;
  surfaceInput: Record<string, unknown>;
  surfaceInputQuery: Record<string, string>;
}

export interface PortalSidebarSection {
  id: string;
  label: string;
  items: PortalSurface[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function readNumber(record: Record<string, unknown>, keys: readonly string[], fallback: number): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return fallback;
}

function readBoolean(record: Record<string, unknown>, keys: readonly string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}

function readPackageEntry(payload: Record<string, unknown>): PortalSurface['packageEntry'] {
  const declared = isRecord(payload.package_entry)
    ? payload.package_entry
    : isRecord(payload.packageEntry)
      ? payload.packageEntry
      : null;
  if (!declared) return null;
  const packageName = readString(declared, ['package_name', 'packageName']);
  const entryName = readString(declared, ['entry_name', 'entryName']);
  return packageName && entryName ? { packageName, entryName } : null;
}

function readRecord(payload: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  for (const key of keys) {
    if (isRecord(payload[key])) return { ...payload[key] };
  }
  return {};
}

function readStringRecord(payload: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const candidate = readRecord(payload, keys);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (key.trim() && typeof value === 'string' && value.trim()) result[key.trim()] = value.trim();
  }
  return result;
}

function readSurface(payload: unknown, index: number): PortalSurface | null {
  if (!isRecord(payload)) return null;
  if (readString(payload, ['kind']) !== 'placeable-surface') return null;

  const materialTarget = readString(payload, ['material_target', 'materialTarget']);
  const target = readString(payload, ['target']);
  const id = readString(payload, ['surface_id', 'surfaceId', 'id']) ?? materialTarget ?? target ?? `surface-${index}`;

  return {
    id,
    label: readString(payload, ['label', 'title']) ?? id,
    description: readString(payload, ['description', 'summary']) ?? '',
    materialTarget,
    target,
    order: readNumber(payload, ['order'], index),
    sectionId: readString(payload, ['section_id', 'sectionId', 'section']) ?? 'portal',
    sectionLabel: readString(payload, ['section_label', 'sectionLabel']) ?? 'Portal',
    showInNavigation: readBoolean(payload, ['show_in_navigation', 'showInNavigation'], true),
    wrapMaterial: readBoolean(payload, ['wrap_material', 'wrapMaterial'], true),
    packageEntry: readPackageEntry(payload),
    surfaceInput: readRecord(payload, ['surface_input', 'surfaceInput']),
    surfaceInputQuery: readStringRecord(payload, ['surface_input_query', 'surfaceInputQuery']),
  };
}

export function readPortalSurfaces(raw: unknown): PortalSurface[] {
  const rows = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const surfaces: PortalSurface[] = [];
  for (const [index, row] of rows.entries()) {
    const surface = readSurface(row, index);
    if (!surface || seen.has(surface.id)) continue;
    seen.add(surface.id);
    surfaces.push(surface);
  }
  return surfaces.sort((a, b) => (
    a.order - b.order ||
    a.label.localeCompare(b.label) ||
    a.id.localeCompare(b.id)
  ));
}

export function readSidebarSections(surfaces: readonly PortalSurface[]): PortalSidebarSection[] {
  const sections = new Map<string, PortalSidebarSection>();
  for (const surface of surfaces) {
    if (!surface.showInNavigation) continue;
    const section = sections.get(surface.sectionId) ?? {
      id: surface.sectionId,
      label: surface.sectionLabel,
      items: [],
    };
    section.items.push(surface);
    sections.set(section.id, section);
  }
  return [...sections.values()];
}

export function findPortalSurface(
  surfaces: readonly PortalSurface[],
  id: string | null | undefined,
): PortalSurface | null {
  if (!id) return null;
  return surfaces.find((surface) => surface.id === id) ?? null;
}

export function defaultPortalSurfaceId(surfaces: readonly PortalSurface[]): string | null {
  return (
    surfaces.find((surface) => surface.id === 'account')?.id ??
    surfaces.find((surface) => surface.showInNavigation)?.id ??
    surfaces[0]?.id ??
    null
  );
}
