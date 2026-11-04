// packages/sidebar/read-data/read-published-records.ts
//
// Sidebar-local discovered-address helpers. The placeable-surface record decoder
// lives in ui/show/placeable-surface-intent so every host consumes the same
// published surface catalog shape.

import { findPlaceableSurfaces as findSharedPlaceableSurfaces, readPlaceableSurfaces as readSharedPlaceableSurfaces, readPublishedRecords as readSharedPublishedRecords, type PlaceableSurfaceRecord, type PublishedRecord } from '../../ui/show/placeable-surface-intent';

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

// A json_array scoped feed (record_from_matching_records, source.path:[]) emits
// {record:{address,source_package}, payload} rows; the shared reader consumes the
// aggregate's {address, payload} shape. Normalize at the boundary so the reader is
// unchanged regardless of which feed served the rows (aggregate rows pass through).
export function normalizeFeedRows(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    if (!isRecord(row)) return row;
    if (typeof row.address === 'string' || !isRecord(row.record)) return row;
    return { address: row.record.address, payload: row.payload };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readReplyProviderTarget(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (!isRecord(value.template)) return null;
  const target = value.target;
  return typeof target === 'string' && target.trim().length > 0 ? target.trim() : null;
}

export function findDiscoveredAddresses(records: readonly PublishedRecord[]): DiscoveredAddress[] {
  const discovered = new Map<string, DiscoveredAddress>();
  for (const record of records) {
    const target = readReplyProviderTarget(record.payload);
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
