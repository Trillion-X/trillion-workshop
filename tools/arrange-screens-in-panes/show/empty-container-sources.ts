// packages/screen-arrangement/show/empty-container-sources.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// What an empty pane shows, as DATA the app hands the arrangement when it mounts
// it. Two things, both chosen by the app and neither known to this package:
//
//   1. `empty_container_surface_ids` — an ordered list of placeable-surface ids
//      (the same catalog rows the sidebar and "Open in new pane" use). The empty
//      pane mounts the first one that is in the catalog and not already on
//      screen, through the same mount a pane uses. Absent or empty: the pane
//      shows only the quick-open launcher, exactly as before.
//   2. The lists source (`surface_collections_scope`, `surface_collections_graph`,
//      `persist_collection_edits`) — the SAME arguments the app gives the
//      sidebar, read by the sidebar's own `useSurfaceCollections`, so the lists
//      an empty pane offers are always the lists the sidebar shows.
//
// Both fields are read from the mount props or from `surfaceInput`, like every
// other arrangement mount field, and the surface list may be a browsing-surface
// presentation value (`{default, when_browsing_surface}`).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. This file names no surface, package, or app. Adding what an empty pane
//    shows is one DATA edit in the app's mount props / package-set row.
// 2. A start surface is shown by at most ONE empty pane at a time (a host page
//    can only be in one place), tracked by the claim store below.
//
// =============================================================================

import * as React from 'react';
import type { SurfaceCollectionsSource } from '../../sidebar/show/use-surface-collections';

export interface EmptyContainerSources {
  /** Ordered placeable-surface ids the empty pane mounts (first available wins). */
  startSurfaceIds: readonly string[];
  /** The lists source, identical to what the app hands the sidebar. */
  collections: SurfaceCollectionsSource;
}

export const NO_EMPTY_CONTAINER_SOURCES: EmptyContainerSources = Object.freeze({
  startSurfaceIds: Object.freeze([]) as readonly string[],
  collections: Object.freeze({}) as SurfaceCollectionsSource,
});

export const EmptyContainerSourcesContext = React.createContext<EmptyContainerSources>(NO_EMPTY_CONTAINER_SOURCES);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function field(props: UnknownRecord | undefined, key: string): unknown {
  const surfaceInput = isRecord(props?.surfaceInput) ? props.surfaceInput : undefined;
  return surfaceInput?.[key] !== undefined ? surfaceInput[key] : props?.[key];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Decode an already-resolved surface id list: strings only, trimmed, de-duplicated, in order. */
export function readStartSurfaceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .map((candidate) => candidate.trim())
    .filter(Boolean))];
}

/** The raw (possibly presentation-valued) start-surface list from mount props. */
export function readRawStartSurfaceIds(props: UnknownRecord | undefined): unknown {
  return field(props, 'empty_container_surface_ids');
}

/** The lists source from mount props, in the sidebar's own vocabulary. */
export function readCollectionsSource(props: UnknownRecord | undefined): SurfaceCollectionsSource {
  const scope = readString(field(props, 'surface_collections_scope'));
  const graph = field(props, 'surface_collections_graph');
  const persistEdits = field(props, 'persist_collection_edits') === true;
  return {
    ...(scope ? { scope } : {}),
    ...(graph !== undefined ? { graph } : {}),
    ...(persistEdits ? { persistEdits } : {}),
  };
}

// ---------------------------------------------------------------------------
// One empty pane per start surface.
// ---------------------------------------------------------------------------

const claims = new Map<string, string>();
const listeners = new Set<() => void>();
let claimsVersion = 0;

function publish(): void {
  claimsVersion += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The first id in `candidates` not claimed by ANOTHER empty pane, claimed for
 * `ownerId` while the calling pane is mounted. Returns null until the claim is
 * held (the layout effect claims before paint, so there is no visible gap) and
 * when no candidate is free, so two panes never mount the same surface.
 */
export function useClaimedStartSurface(ownerId: string, candidates: readonly string[]): string | null {
  React.useSyncExternalStore(subscribe, () => claimsVersion, () => claimsVersion);
  const wanted = candidates.find((id) => {
    const owner = claims.get(id);
    return owner === undefined || owner === ownerId;
  }) ?? null;

  React.useLayoutEffect(() => {
    if (!wanted || claims.has(wanted)) return undefined;
    claims.set(wanted, ownerId);
    publish();
    return () => {
      if (claims.get(wanted) === ownerId) {
        claims.delete(wanted);
        publish();
      }
    };
  }, [wanted, ownerId]);

  return wanted && claims.get(wanted) === ownerId ? wanted : null;
}

const NO_CANDIDATES: readonly string[] = Object.freeze([]) as readonly string[];

/**
 * The start surface one empty tab shows. Each empty tab claims under its own
 * pane-and-tab identity, and a tab that is not on screen claims nothing, so a
 * hidden empty tab can never hold the start surface away from the empty pane a
 * person is looking at.
 */
export function useStartSurfaceForEmptyTab(
  containerId: string,
  tabId: string | null,
  shown: boolean,
  candidates: readonly string[],
): string | null {
  return useClaimedStartSurface(`${containerId}:${tabId ?? ''}`, shown ? candidates : NO_CANDIDATES);
}
