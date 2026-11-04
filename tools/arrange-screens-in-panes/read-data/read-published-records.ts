// packages/screen-arrangement/read-data/read-published-records.ts
//
// Screen-local discovered-address helpers. The placeable-surface record decoder
// lives in ui/show/placeable-surface-intent so every host consumes the same
// published surface catalog shape.

import {
  findPlaceableSurfaces as findSharedPlaceableSurfaces,
  readPlaceableSurfaces as readSharedPlaceableSurfaces,
  readPublishedRecords as readSharedPublishedRecords,
  type PlaceableSurfaceRecord,
  type PublishedRecord,
} from '../../ui/show/placeable-surface-intent/placeable-surface-record';
import { makeIdentityTextAddressFromLabel } from '#workspace-records';

export type { PlaceableSurfaceRecord, PublishedRecord };

export interface DiscoveredAddress {
  target: string;
  recordId: string;
  sourcePath: string;
  payload: unknown;
}

export const readPublishedRecords = readSharedPublishedRecords;
export const readPlaceableSurfaces = readSharedPlaceableSurfaces;
export const findPlaceableSurfaces = findSharedPlaceableSurfaces;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function surfaceInputOverridesAddress(catalogAddress: string): string {
  return `package::screen-arrangement::placeable-surface-input-overrides::${encodeURIComponent(catalogAddress)}`;
}

export function surfaceInputOverridesReadInput(catalogAddress: string): {
  input: 'selector-source-by-address';
  params: { address: string };
} {
  return {
    input: 'selector-source-by-address',
    params: {
      address: makeIdentityTextAddressFromLabel(surfaceInputOverridesAddress(catalogAddress)),
    },
  };
}

export function applyPlaceableSurfaceInputOverrides(
  surfaces: readonly PlaceableSurfaceRecord[],
  raw: unknown,
): PlaceableSurfaceRecord[] {
  if (!isRecord(raw) || !Array.isArray(raw.surface_input_overrides)) return [...surfaces];
  const overrides = new Map<string, Record<string, unknown>>();
  for (const entry of raw.surface_input_overrides) {
    if (!isRecord(entry) || !isRecord(entry.surface_input)) continue;
    const surfaceId = readString(entry.surface_id);
    if (surfaceId) overrides.set(surfaceId, entry.surface_input);
  }
  return surfaces.map((surface) => {
    const override = overrides.get(surface.id);
    if (!override) return surface;
    return { ...surface, surfaceInput: { ...(surface.surfaceInput ?? {}), ...override } };
  });
}

export function readPlaceableSurfacesWithInputOverrides(
  placeableSurfaceListEntry: unknown,
  placeableSurfaceInputOverridesEntry: unknown,
): PlaceableSurfaceRecord[] {
  return applyPlaceableSurfaceInputOverrides(
    readPlaceableSurfaces(placeableSurfaceListEntry),
    placeableSurfaceInputOverridesEntry,
  );
}

function readTarget(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return readString(value.target);
}

export function findDiscoveredAddresses(records: readonly PublishedRecord[]): DiscoveredAddress[] {
  const discovered = new Map<string, DiscoveredAddress>();
  for (const record of records) {
    const target = readTarget(record.payload);
    if (!target) continue;
    discovered.set(`${target}:${record.recordId}`, {
      target,
      recordId: record.recordId,
      sourcePath: 'payload.target',
      payload: record.payload,
    });
  }
  return [...discovered.values()].sort((a, b) => (
    a.target.localeCompare(b.target) ||
    a.recordId.localeCompare(b.recordId) ||
    a.sourcePath.localeCompare(b.sourcePath)
  ));
}

export function findDiscoveredAddressForTarget(
  records: readonly PublishedRecord[],
  target: string,
): DiscoveredAddress | null {
  return findDiscoveredAddresses(records).find((address) => address.target === target) ?? null;
}
