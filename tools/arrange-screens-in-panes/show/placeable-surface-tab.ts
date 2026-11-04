import type { PlaceableSurfaceRecord } from '../read-data/read-published-records';
import { EMPTY_TAB_TITLE, type PackageEntryReference, type TabMeta } from '../read-data/layout-types';

function makeTabId(seed: string | null): string {
  const base = (seed ?? 'tab')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'tab';
  return `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function tabPatchForPlaceableSurface(surface: PlaceableSurfaceRecord): Partial<TabMeta> {
  return {
    title: surface.label,
    target: surface.target ?? null,
    packageEntry: surface.packageEntry ?? null,
    materialTarget: surface.materialTarget,
    icon: surface.icon ?? 'Square',
    closable: true,
    metadata: {
      placeable_surface_id: surface.id,
      placeable_surface_label: surface.label,
      placeable_surface_material_target: surface.materialTarget,
      surfaceInputBinding: 'catalog',
      ...(surface.surfaceInput ? { surfaceInput: surface.surfaceInput } : {}),
    },
  };
}

export function tabForPlaceableSurface(surface: PlaceableSurfaceRecord): TabMeta {
  return {
    id: makeTabId(surface.id ?? surface.packageEntry?.entryName ?? surface.materialTarget ?? surface.label),
    ...tabPatchForPlaceableSurface(surface),
  } as TabMeta;
}

export function tabWithId(tab: TabMeta, id: string): TabMeta {
  return tab.id === id ? tab : { ...tab, id };
}

export function isEmptySurfaceTab(tab: TabMeta | null | undefined): tab is TabMeta {
  return !!tab && !tab.target && !tab.packageEntry && !tab.materialTarget;
}

function samePackageEntry(
  left: PackageEntryReference | null | undefined,
  right: PackageEntryReference | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  return left.packageName === right.packageName && left.entryName === right.entryName;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

/** Whether two inputs say the same thing, whatever order their keys were written in (a saved layout comes back with
 *  its keys in another order than the request that opened it). */
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stableStringify(left) === stableStringify(right);
}

function sameSurfaceInput(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return true;
  return stableStringify(left) === stableStringify(right);
}

export function tabShowsPlaceableSurface(
  tab: TabMeta | null | undefined,
  surface: PlaceableSurfaceRecord,
): boolean {
  if (!tab) return false;
  const surfaceId = tab.metadata?.placeable_surface_id;
  if (typeof surfaceId === 'string') return surfaceId === surface.id;
  return tab.materialTarget === surface.materialTarget
    && samePackageEntry(tab.packageEntry, surface.packageEntry ?? null)
    && (tab.target ?? null) === (surface.target ?? null)
    && sameSurfaceInput(tab.metadata?.surfaceInput, surface.surfaceInput);
}

export function currentSurfaceForTab(
  tab: TabMeta,
  surfaces: readonly PlaceableSurfaceRecord[],
): PlaceableSurfaceRecord | null {
  return surfaces.find((surface) => tabShowsPlaceableSurface(tab, surface)) ?? null;
}

/**
 * The catalog screen a tab shows: its own surface, or else the surface with the same mount (package entry, material
 * and target) whose own input the tab's input carries, which is how a tab opened with its own input (one space, one
 * decision, one file) is held.
 */
export function surfaceShownByTab(
  tab: TabMeta,
  surfaces: readonly PlaceableSurfaceRecord[],
): PlaceableSurfaceRecord | null {
  if (typeof tab.metadata?.placeable_surface_id === 'string') {
    const exact = currentSurfaceForTab(tab, surfaces);
    // A catalog tab names its owner exactly. An invocation's stamped identity may instead name that particular
    // opening; resolve its owner by the same mount and most-specific input, never by interpreting an id prefix.
    if (exact || tab.metadata?.surfaceInputBinding !== 'invocation') return exact;
  }
  const input = tab.metadata?.surfaceInput;
  const carries = (surface: PlaceableSurfaceRecord) => Object.entries(surface.surfaceInput ?? {})
    .every(([name, value]) => input !== null && typeof input === 'object' && sameValue((input as Record<string, unknown>)[name], value));
  // Of the same mount, the surface whose own input says the most about this tab is the one it shows.
  const candidates = surfaces.filter((surface) => samePackageEntry(tab.packageEntry, surface.packageEntry ?? null)
    && (tab.materialTarget ?? null) === (surface.materialTarget ?? null)
    && (tab.target ?? null) === (surface.target ?? null)
    && carries(surface));
  return candidates.reduce<PlaceableSurfaceRecord | null>((best, surface) =>
    (best && Object.keys(best.surfaceInput ?? {}).length >= Object.keys(surface.surfaceInput ?? {}).length ? best : surface), null);
}

/** Whether a tab shows a screen the catalog still offers: one it shows, or any surface with the same mount. */
export function tabIsOffered(
  tab: TabMeta,
  surfaces: readonly PlaceableSurfaceRecord[],
): boolean {
  if (surfaceShownByTab(tab, surfaces)) return true;
  return surfaces.some((surface) => samePackageEntry(tab.packageEntry, surface.packageEntry ?? null)
    && (tab.materialTarget ?? null) === (surface.materialTarget ?? null)
    && (tab.target ?? null) === (surface.target ?? null));
}

/**
 * The host's accepted catalog can explicitly withdraw an owner before an unrelated source finishes loading.
 * Such tabs close without the same-mount fallback used for otherwise unknown tabs. A reoffered identity always
 * wins over a stale withdrawal; every other absent tab waits until the catalog is authoritatively complete.
 */
export function tabsToCloseForCatalog(
  tabs: readonly TabMeta[],
  surfaces: readonly PlaceableSurfaceRecord[],
  { complete, withdrawn = [] }: { complete: boolean; withdrawn?: readonly PlaceableSurfaceRecord[] },
): TabMeta[] {
  const offeredIds = new Set(surfaces.map(surface => surface.id));
  const removed = withdrawn.filter(surface => !offeredIds.has(surface.id));
  const removedIds = new Set(removed.map(surface => surface.id));
  const known = [...surfaces, ...removed];
  return tabs.filter(tab => {
    if (isEmptySurfaceTab(tab)) return false;
    const owner = removed.length ? surfaceShownByTab(tab, known) : null;
    return (owner !== null && removedIds.has(owner.id)) || (complete && !tabIsOffered(tab, surfaces));
  });
}

export function tabWithCurrentSurfaceLabel(
  tab: TabMeta,
  surfaces: readonly PlaceableSurfaceRecord[],
): TabMeta {
  const surface = currentSurfaceForTab(tab, surfaces);
  if (!surface) {
    // A tab whose surface is not in this app's catalog shows the thing picker, so it
    // is an empty tab. Layouts saved before the slot stopped titling tabs by id still
    // carry the bare surface id as a title; an id is never shown as words.
    const surfaceId = tab.metadata?.placeable_surface_id;
    const titledById = !tab.title.trim() || (typeof surfaceId === 'string' && tab.title === surfaceId);
    return titledById ? { ...tab, title: EMPTY_TAB_TITLE } : tab;
  }
  // A tab opened for one thing keeps the name and icon it was opened with (the list an AI made, titled "Reading
  // list"; a decision by its question); a tab showing the screen itself (opened with no input beyond the screen's
  // own) follows the screen's current label and icon, so a screen the person renamed or gave another icon changes in
  // every tab at once.
  const opened = tab.metadata?.surfaceInput;
  const ownInput = surface.surfaceInput ?? {};
  const showsTheScreen = !opened || typeof opened !== 'object' || Object.entries(opened as Record<string, unknown>)
    .every(([name, value]) => name.startsWith('surface_intent') || (ownInput as Record<string, unknown>)[name] === value);
  const forOneThing = tab.metadata?.surfaceInputBinding === 'invocation' && !showsTheScreen;
  const ownTitle = forOneThing
    && !!tab.title.trim()
    && tab.title !== tab.metadata?.placeable_surface_id;
  const title = ownTitle ? tab.title : surface.label;
  const icon = forOneThing && tab.icon ? tab.icon : surface.icon ?? tab.icon;
  const metadata: Record<string, unknown> = {
    ...(tab.metadata ?? {}),
    placeable_surface_label: surface.label,
    placeable_surface_material_target: surface.materialTarget,
  };
  // The catalog owns the surface's mount contract. Layout persistence owns only
  // where the tab lives and its user-controlled arrangement. Keeping an old
  // `surfaceInput` snapshot here makes DATA-only additions/removals invisible
  // until the user deletes the tab, so refresh (or remove) it from the current
  // catalog record alongside the current package/target identity.
  if (tab.metadata?.surfaceInputBinding !== 'invocation') {
    if (surface.surfaceInput) metadata.surfaceInput = surface.surfaceInput;
    else delete metadata.surfaceInput;
  }
  // A tab tracks its surface's CURRENT mount identity, not a snapshot from when it was
  // opened. If the surface's package moves (e.g. a capability extracted into its own
  // product package), already-open tabs re-point to the new entry automatically — no
  // one-off migration. The tab is still matched to the surface by its stable surface id
  // (tabShowsPlaceableSurface), so the match survives the entry change.
  const nextPackageEntry = surface.packageEntry ?? null;
  const nextMaterialTarget = surface.materialTarget;
  const nextTarget = surface.target ?? null;
  if (
    tab.title === title
    && icon === tab.icon
    && sameSurfaceInput(metadata, tab.metadata)
    && samePackageEntry(tab.packageEntry, nextPackageEntry)
    && tab.materialTarget === nextMaterialTarget
    && (tab.target ?? null) === nextTarget
  ) {
    return tab;
  }
  return {
    ...tab,
    title,
    ...(icon ? { icon } : {}),
    packageEntry: nextPackageEntry,
    materialTarget: nextMaterialTarget,
    target: nextTarget,
    metadata,
  };
}
