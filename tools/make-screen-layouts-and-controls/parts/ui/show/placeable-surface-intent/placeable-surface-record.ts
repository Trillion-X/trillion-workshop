// packages/ui/show/placeable-surface-intent/placeable-surface-record.ts
//
// Browser-local decoder for placeable-surface records. It converts maintained
// surface-list values into a generic surface catalog without importing a screen
// host or an owner package.

import { readGlanceDeclaration, readSurfaceActions, type GlanceDeclaration, type SurfaceActionData } from '../surface-preview/surface-glance';

export interface PublishedRecord {
  recordId: string;
  path: readonly string[];
  payload: unknown;
  row: Record<string, unknown>;
  sourcePackage?: string;
}

export interface PlaceableSurfaceRecord {
  id: string;
  label: string;
  packageEntry?: {
    packageName: string;
    entryName: string;
  };
  materialTarget: string;
  target?: string;
  icon?: string;
  badge?: string;
  order: number;
  disabled?: boolean;
  /**
   * Nav-offerability gate (Society DATA, generic). `listed: false` means the
   * surface EXISTS (openable by route/intent, embeddable, placeable by explicit
   * reference) but is offered in NO navigation catalog: not the sidebar's
   * uncollected "Things" section, not add-to-list pickers. Absent/true =
   * offered, so every existing record stays listed (back-compat). This is the
   * inverse of L182 (capability-existence != nav-placement): existence without
   * nav offer. A user list that explicitly references an unlisted surface still
   * renders it, because explicit placement is deliberate DATA and always wins.
   */
  listed?: boolean;
  /**
   * Capability gate (Society DATA, generic). The access refs a viewer must hold
   * for this surface to be offerable. Empty = ungated (public → always offered).
   * A gated surface is offered only when the viewer holds ANY of these refs. The
   * refs are OPAQUE strings — the surface catalog/layout never interprets them; an
   * app supplies the viewer's held refs and the same any-of-intersection predicate
   * the content-entitlement leaf uses (`access-scoped-content` `isItemEntitled`)
   * decides visibility. Absent field + no held-refs context → unrestricted (studio
   * owner sees everything; a student sees only entitled surfaces). Normalized from
   * `required_access_ref` (string) and/or `required_access_refs` (array) DATA.
   * The decoder always sets this (empty when the DATA declares no gate).
   */
  requiredAccessRefs?: readonly string[];
  /**
   * Dedupe-on-open policy (Society DATA). 'focus-existing' (default, omitted):
   * opening a surface that is already open in a tab FOCUSES that tab instead of
   * spawning a duplicate. 'new-tab': every open mints a fresh tab (apps that
   * legitimately want multiple views of one surface opt in here). Keeping this in
   * DATA — not hardcoded in the layout engine — is why "one tab per surface" is
   * not baked into Physics.
   */
  openMode?: 'focus-existing' | 'new-tab';
  routePaths: readonly string[];
  routePrefixes: readonly string[];
  /**
   * The input key an address under this surface's prefix supplies (`route_input`: `/decisions/<id>` gives `id`). A
   * surface that names one shows one thing, so it never opens without that input: asked for by name it shows a tab
   * already open for one thing, or nothing.
   */
  addressInput?: string;
  entryContexts?: readonly EntryContextMatcher[];
  acceptsMaterialKinds: readonly string[];
  surfaceInput?: Record<string, unknown>;
  initialArrangement?: Record<string, unknown>;
  /**
   * Where a catalog open places this surface (Society DATA, `open_placement`).
   * Absent = a tab in the chosen container. `layer: 'overlay'` opens it as a
   * picture-in-picture window of `size`; `chrome` is that window's own
   * chrome-visibility map (for example `{header: false}` hides the tab bar, and
   * the window shows the shared floating grab strip instead). Explicit
   * placements in a request (drag onto a container, "open beside") still win.
   */
  openPlacement?: OpenPlacement;
  /** Another surface whose content a navigation hover preview shows (`preview_surface_id`). */
  previewSurfaceId?: string;
  /** Live badge channel a navigation row shows (`badge_source`), see ui/show/surface-badges. */
  badgeSource?: string;
  /**
   * Where a navigation shows this screen instead of its lists (`sidebar_place`): `controls` puts it among the
   * navigation's own always-shown controls as an icon with its live badge (a notification bell); `bottom` keeps it
   * at the foot of the navigation, below every list.
   */
  sidebarPlace?: string;
  /** The colour a navigation draws this row in (`sidebar_colour`): a hue of the shared screen-look palette. */
  sidebarColour?: string;
  /** What a hover card reads for its live look (`glance`), see ui/show/surface-preview/surface-glance. */
  glance?: GlanceDeclaration;
  /** Actions a hover card and row menu offer (`actions`); each dispatches a window event named by DATA. */
  surfaceActions?: readonly SurfaceActionData[];
  /** One plain sentence about the screen (`description`). */
  description?: string;
  /**
   * What a sidebar lets a person do with this screen's row (`sidebar_settings`,
   * named switches such as `remove_from_list: false`), the item level of the
   * sidebar's global → list → item settings. Only true/false entries are kept.
   */
  sidebarSettings?: Readonly<Record<string, boolean>>;
  payload: unknown;
}

export interface OpenPlacement {
  layer: string;
  size?: {width: number; height: number};
  /** Where the window's centre sits, as fractions of the screen: `{x: 0.5, y: 0.5}` is the middle. Absent: the arranger's own spot. */
  anchor?: {x: number; y: number};
  chrome?: Record<string, boolean>;
  /**
   * The looks the window opens with: each key names a region the window owns (the arrangement says which names it
   * places, such as the window itself and the screen behind it), each value that region's layer stack.
   */
  looks?: Record<string, OpenPlacementLook>;
  /** True: a press outside the window closes it. */
  closesOnOutside?: boolean;
}

/** One region's look in an open placement: the same layers and frame a region's visual layer stack holds. */
export interface OpenPlacementLook {
  layers: readonly Record<string, unknown>[];
  frame?: Record<string, unknown>;
}

export interface EntryContextMatcher {
  hosts: readonly string[];
  hostSuffixes: readonly string[];
  paths: readonly string[];
  pathPrefixes: readonly string[];
  query: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRecordList(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) return raw;
  return isRecord(raw) && Array.isArray(raw.records) ? raw.records : [];
}

function readRecordId(address: unknown, index: number): string {
  if (typeof address === 'string' && address.length > 0) return address;
  return `published-record-${index}`;
}

function readSourcePackageFromAddress(address: string): string | undefined {
  const match = /^(?:package|published-record)::([^:]+)::/.exec(address);
  return match?.[1] && match[1].trim().length > 0 ? match[1] : undefined;
}

function readPath(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string') : [];
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFirstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return null;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => item.trim().length > 0).map((item) => item.trim())
    : [];
}

const fraction = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);

/** Reads an open placement from a surface row or an open request (`open_placement`); null when it names no layer. */
export function readOpenPlacement(value: unknown): OpenPlacement | null {
  if (!isRecord(value)) return null;
  const layer = readString(value.layer);
  if (!layer) return null;
  const size = isRecord(value.size) ? value.size : null;
  const width = size ? readNumber(size.width, 0) : 0;
  const height = size ? readNumber(size.height, 0) : 0;
  const chrome: Record<string, boolean> = {};
  if (isRecord(value.chrome)) {
    for (const [zone, visible] of Object.entries(value.chrome)) if (typeof visible === 'boolean') chrome[zone] = visible;
  }
  const anchor = isRecord(value.anchor) ? value.anchor : null;
  const anchorX = anchor ? fraction(anchor.x) : null;
  const anchorY = anchor ? fraction(anchor.y) : null;
  const looks: Record<string, OpenPlacementLook> = {};
  if (isRecord(value.looks)) {
    for (const [region, look] of Object.entries(value.looks)) {
      if (!isRecord(look) || !Array.isArray(look.layers)) continue;
      looks[region] = { layers: look.layers.filter(isRecord), ...(isRecord(look.frame) ? { frame: look.frame } : {}) };
    }
  }
  const closesOnOutside = value.closes_on_outside ?? value.closesOnOutside;
  return {
    layer,
    ...(width > 0 && height > 0 ? { size: { width, height } } : {}),
    ...(anchorX !== null && anchorY !== null ? { anchor: { x: anchorX, y: anchorY } } : {}),
    ...(Object.keys(chrome).length > 0 ? { chrome } : {}),
    ...(Object.keys(looks).length > 0 ? { looks } : {}),
    ...(closesOnOutside === true ? { closesOnOutside: true } : {}),
  };
}

function readStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) continue;
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      result[key.trim()] = String(entry).trim();
    }
  }
  return result;
}

function readFirstArray(record: Record<string, unknown>, keys: readonly string[]): readonly string[] {
  for (const key of keys) {
    const value = readStringArray(record[key]);
    if (value.length > 0) return value;
  }
  return [];
}

function readFirstRecord(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
  }
  return null;
}

/**
 * Normalize a surface's capability gate from DATA into a deduped ref array.
 * Reads `required_access_ref` (singular string) AND `required_access_refs`
 * (array) — the SAME field names the content-entitlement leaf uses
 * (`access-scoped-content` `acceptedAccessRefs`) — so a surface and its content
 * share one access vocabulary. Empty array = ungated (public).
 *
 * `audience` joins that same vocabulary as `audience:<value>` rather than
 * becoming a second gate beside this one. Surfaces have declared it for a long
 * time, eighteen of them saying `operator`, and nothing anywhere read it, so a
 * customer-facing app offered every authoring tool its installed packages
 * happened to publish: "Build a form" in the navigation of a product whose
 * whole idea is that it builds the form for you. Leaving those packages out is
 * not the answer, because the capability is wanted; what has to go is the
 * DESTINATION. Expressed as a ref, one gate still decides, and an app that
 * says nothing about its viewer is unchanged.
 */
function readRequiredAccessRefs(payload: Record<string, unknown>): readonly string[] {
  const refs = new Set<string>();
  for (const ref of readFirstArray(payload, ['required_access_refs', 'requiredAccessRefs'])) refs.add(ref);
  const singular = readFirstString(payload, ['required_access_ref', 'requiredAccessRef']);
  if (singular) refs.add(singular);
  const audience = readFirstString(payload, ['audience']);
  if (audience) refs.add(`audience:${audience}`);
  return [...refs];
}

function readEntryContextMatcher(value: unknown): EntryContextMatcher | null {
  if (!isRecord(value)) return null;
  const matcher: EntryContextMatcher = {
    hosts: readFirstArray(value, ['hosts', 'hostnames', 'entry_hosts', 'entryHosts']),
    hostSuffixes: readFirstArray(value, ['host_suffixes', 'hostSuffixes', 'entry_host_suffixes', 'entryHostSuffixes']),
    paths: readFirstArray(value, ['paths', 'route_paths', 'routePaths', 'entry_paths', 'entryPaths']),
    pathPrefixes: readFirstArray(value, ['path_prefixes', 'pathPrefixes', 'route_prefixes', 'routePrefixes', 'entry_path_prefixes', 'entryPathPrefixes']),
    query: readStringMap(readFirstRecord(value, ['query', 'query_equals', 'queryEquals', 'entry_query', 'entryQuery'])),
  };
  const hasAnyMatcher = matcher.hosts.length > 0
    || matcher.hostSuffixes.length > 0
    || matcher.paths.length > 0
    || matcher.pathPrefixes.length > 0
    || Object.keys(matcher.query).length > 0;
  return hasAnyMatcher ? matcher : null;
}

function readEntryContextMatchers(payload: Record<string, unknown>): readonly EntryContextMatcher[] {
  const direct = payload.entry_contexts ?? payload.entryContexts;
  const directMatchers = Array.isArray(direct)
    ? direct.map(readEntryContextMatcher).filter((matcher): matcher is EntryContextMatcher => matcher !== null)
    : [];
  const singularMatcher = readEntryContextMatcher(payload.entry_context ?? payload.entryContext);
  const topLevelMatcher = readEntryContextMatcher({
    hosts: payload.entry_hosts ?? payload.entryHosts,
    host_suffixes: payload.entry_host_suffixes ?? payload.entryHostSuffixes,
    paths: payload.entry_paths ?? payload.entryPaths,
    path_prefixes: payload.entry_path_prefixes ?? payload.entryPathPrefixes,
    query: payload.entry_query ?? payload.entryQuery,
  });
  return [
    ...directMatchers,
    ...(singularMatcher ? [singularMatcher] : []),
    ...(topLevelMatcher ? [topLevelMatcher] : []),
  ];
}

function readEntryName(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith('component:') ? value.slice('component:'.length) : value;
}

function readPackageEntry(
  payload: Record<string, unknown>,
  record: PublishedRecord,
  materialTarget: string,
): PlaceableSurfaceRecord['packageEntry'] {
  const declaredEntry = isRecord(payload.package_entry)
    ? payload.package_entry
    : isRecord(payload.packageEntry)
      ? payload.packageEntry
      : null;
  const packageName = declaredEntry
    ? readString(declaredEntry.package_name) ?? readString(declaredEntry.packageName) ?? record.sourcePackage
    : record.sourcePackage;
  const entryName = declaredEntry
    ? readString(declaredEntry.entry_name) ?? readString(declaredEntry.entryName) ?? readEntryName(readFirstString(payload, ['entry_name', 'entryName']) ?? materialTarget)
    : readEntryName(readFirstString(payload, ['entry_name', 'entryName']) ?? materialTarget);
  return packageName && entryName ? { packageName, entryName } : undefined;
}

function readPlaceableSurface(record: PublishedRecord, index: number): PlaceableSurfaceRecord | null {
  if (!isRecord(record.payload)) return null;
  if (readString(record.payload.kind) !== 'placeable-surface') return null;

  const materialTarget = readFirstString(record.payload, [
    'material_target',
    'materialTarget',
    'surface_target',
    'surfaceTarget',
    'address_to_ask',
    'addressToAsk',
    'address',
    'target',
  ]);
  if (!materialTarget) return null;

  const surfaceInput = record.payload.surfaceInput ?? record.payload.surface_input;
  const initialArrangement = record.payload.initialArrangement ?? record.payload.initial_arrangement;
  const entryContexts = readEntryContextMatchers(record.payload);
  const target = readFirstString(record.payload, ['target', 'address_to_ask', 'addressToAsk', 'address']);
  const label = readFirstString(record.payload, ['label', 'title', 'name']) ?? materialTarget;
  const id = readFirstString(record.payload, ['id', 'surface_id', 'surfaceId']) ?? record.recordId;
  const packageEntry = readPackageEntry(record.payload, record, materialTarget);
  const requiredAccessRefs = readRequiredAccessRefs(record.payload);
  const openPlacement = readOpenPlacement(record.payload.open_placement ?? record.payload.openPlacement);
  const previewSurfaceId = readFirstString(record.payload, ['preview_surface_id', 'previewSurfaceId']);
  const badgeSource = readFirstString(record.payload, ['badge_source', 'badgeSource']);
  const sidebarPlace = readFirstString(record.payload, ['sidebar_place', 'sidebarPlace']);
  const sidebarColour = readFirstString(record.payload, ['sidebar_colour', 'sidebarColour']);
  const glance = readGlanceDeclaration(record.payload.glance);
  const surfaceActions = readSurfaceActions(record.payload.actions);
  const description = readFirstString(record.payload, ['description']);
  const rawSidebarSettings = record.payload.sidebar_settings;
  const sidebarSettings = rawSidebarSettings && typeof rawSidebarSettings === 'object' && !Array.isArray(rawSidebarSettings)
    ? Object.fromEntries(Object.entries(rawSidebarSettings as Record<string, unknown>).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
    : {};

  return {
    id,
    label,
    ...(requiredAccessRefs.length > 0 ? { requiredAccessRefs } : {}),
    ...(packageEntry ? { packageEntry } : {}),
    materialTarget,
    ...(target ? { target } : {}),
    icon: readFirstString(record.payload, ['icon']) ?? undefined,
    badge: readFirstString(record.payload, ['badge']) ?? undefined,
    order: readNumber(record.payload.order, index),
    disabled: readBoolean(record.payload.disabled),
    ...(readBoolean(record.payload.listed) === false ? { listed: false } : {}),
    ...(readFirstString(record.payload, ['open_mode', 'openMode']) === 'new-tab'
      ? { openMode: 'new-tab' as const }
      : {}),
    routePaths: readStringArray(record.payload.route_paths ?? record.payload.routePaths),
    routePrefixes: readStringArray(record.payload.route_prefixes ?? record.payload.routePrefixes),
    // An exact route opens the overview without a detail id. A prefix-only screen needs its route input.
    ...(readStringArray(record.payload.route_paths ?? record.payload.routePaths).length === 0
      && readFirstString(record.payload, ['route_input', 'routeInput'])
      ? { addressInput: readFirstString(record.payload, ['route_input', 'routeInput'])! }
      : {}),
    ...(entryContexts.length > 0 ? { entryContexts } : {}),
    acceptsMaterialKinds: readStringArray(record.payload.accepts_material_kinds ?? record.payload.acceptsMaterialKinds),
    ...(isRecord(surfaceInput) ? { surfaceInput } : {}),
    ...(isRecord(initialArrangement) ? { initialArrangement } : {}),
    ...(openPlacement ? { openPlacement } : {}),
    ...(previewSurfaceId ? { previewSurfaceId } : {}),
    ...(badgeSource ? { badgeSource } : {}),
    ...(sidebarPlace ? { sidebarPlace } : {}),
    ...(sidebarColour ? { sidebarColour } : {}),
    ...(glance ? { glance } : {}),
    ...(surfaceActions.length ? { surfaceActions } : {}),
    ...(description ? { description } : {}),
    ...(Object.keys(sidebarSettings).length ? { sidebarSettings } : {}),
    payload: record.payload,
  };
}

export function readPublishedRecords(raw: unknown): PublishedRecord[] {
  const rows = readRecordList(raw);
  if (rows.length === 0) return [];
  const records: PublishedRecord[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const record = readPublishedRecordFromUnknown(row, rowIndex);
    if (record) records.push(record);
  }
  return records;
}

export function readPublishedRecordFromUnknown(
  raw: unknown,
  index = 0,
): PublishedRecord | null {
  if (typeof raw === 'string') {
    try {
      return readPublishedRecordFromUnknown(JSON.parse(raw) as unknown, index);
    } catch {
      return null;
    }
  }
  if (!isRecord(raw)) return null;

  const nestedPublishedRecord = isRecord(raw.publishedRecord)
    ? raw.publishedRecord
    : isRecord(raw.published_record)
      ? raw.published_record
      : null;
  if (nestedPublishedRecord) {
    return readPublishedRecordFromUnknown(nestedPublishedRecord, index);
  }

  if (readString(raw.kind) === 'published-record' && isRecord(raw.record)) {
    return readPublishedRecordFromUnknown(raw.record, index);
  }

  // A scoped record_from_matching_records json_array feed (source.path:[]) emits
  // {record:{address,source_package}, payload} rows with NO wrapping kind. Read
  // the address from record.address so a scoped-feed row decodes identically to
  // the same record served from the published-records aggregate — every consumer
  // of readPublishedRecords works with scoped feeds, no per-package normalizer.
  if (isRecord(raw.record) && isRecord(raw.payload) && readString(raw.record.address)) {
    const recordId = readRecordId(raw.record.address, index);
    return {
      recordId,
      path: readPath(raw.path),
      payload: raw.payload,
      row: raw,
      sourcePackage: readString(raw.record.source_package)
        ?? readString(raw.source_package)
        ?? readSourcePackageFromAddress(recordId),
    };
  }

  if (isRecord(raw.payload)) {
    if (readString(raw.payload.kind) === 'published-record' && isRecord(raw.payload.record)) {
      return readPublishedRecordFromUnknown(raw.payload.record, index);
    }
    const recordId = readRecordId(raw.address, index);
    return {
      recordId,
      path: readPath(raw.path),
      payload: raw.payload,
      row: raw,
      sourcePackage: readString(raw.source_package)
        ?? readString(raw.sourcePackage)
        ?? readSourcePackageFromAddress(recordId),
    };
  }

  if (readString(raw.kind)) {
    const recordId = readRecordId(raw.address ?? raw.id, index);
    return {
      recordId,
      path: readPath(raw.path),
      payload: raw,
      row: raw,
      sourcePackage: readString(raw.source_package)
        ?? readString(raw.sourcePackage)
        ?? readSourcePackageFromAddress(recordId),
    };
  }

  return null;
}

/**
 * Whether a surface is offerable to a viewer holding `heldAccessRefs`. Generic
 * capability gate (the same any-of-intersection the content-entitlement leaf uses
 * for items): a surface with no `requiredAccessRefs` is ungated (always offered);
 * a gated surface is offered only when the viewer holds ANY required ref. The refs
 * are opaque strings — this predicate names no domain and no product.
 *
 * `heldAccessRefs === undefined` means "no capability context" (e.g. the studio
 * owner shell, which does not publish viewer grants) → UNRESTRICTED: every surface
 * is offered, gated or not. So the gate only ever narrows a catalog for an app
 * that actually supplies the viewer's held refs; every other app is unchanged.
 */
export function surfaceOfferedToViewer(
  surface: Pick<PlaceableSurfaceRecord, 'requiredAccessRefs'>,
  heldAccessRefs: readonly string[] | undefined,
): boolean {
  if (heldAccessRefs === undefined) return true;
  const required = surface.requiredAccessRefs ?? [];
  if (required.length === 0) return true;
  const held = new Set(heldAccessRefs);
  return required.some((ref) => held.has(ref));
}

/** Keep only the surfaces offerable to a viewer holding `heldAccessRefs`
 *  (`undefined` held-refs → unrestricted, catalog returned unchanged). */
export function offerableSurfaces<T extends Pick<PlaceableSurfaceRecord, 'requiredAccessRefs'>>(
  surfaces: readonly T[],
  heldAccessRefs: readonly string[] | undefined,
): T[] {
  if (heldAccessRefs === undefined) return [...surfaces];
  return surfaces.filter((surface) => surfaceOfferedToViewer(surface, heldAccessRefs));
}

export function findPlaceableSurfaces(records: readonly PublishedRecord[]): PlaceableSurfaceRecord[] {
  return convergePlaceableSurfaces(records
    .map(readPlaceableSurface)
    .filter((surface): surface is PlaceableSurfaceRecord => surface !== null));
}

export function readPlaceableSurfaces(raw: unknown): PlaceableSurfaceRecord[] {
  const decoded = readRecordList(raw)
    .map((entry, index) => readPlaceableSurfaceRecordFromUnknown(entry, index))
    .filter((surface): surface is PlaceableSurfaceRecord => surface !== null);
  return convergePlaceableSurfaces(decoded);
}

function convergePlaceableSurfaces(decoded: readonly PlaceableSurfaceRecord[]): PlaceableSurfaceRecord[] {
  const lastIndexById = new Map<string, number>();
  decoded.forEach((surface, index) => lastIndexById.set(surface.id, index));
  return decoded.filter((surface, index) => lastIndexById.get(surface.id) === index);
}

export function readPlaceableSurfaceRecordFromUnknown(
  raw: unknown,
  index = 0,
): PlaceableSurfaceRecord | null {
  const record = readPublishedRecordFromUnknown(raw, index);
  return record ? readPlaceableSurface(record, index) : null;
}
