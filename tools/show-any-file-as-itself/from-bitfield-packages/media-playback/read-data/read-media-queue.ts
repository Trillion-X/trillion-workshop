// packages/media-playback/read-data/read-media-queue.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Projects the single "current queue" published-record (written by
// do-work/reorder-queue.ts) into an ordered list of resolved MediaSourceRecord
// rows. Reuses readMediaPlaybackData/findMediaSource from read-media-playback
// for source projection — this file adds ONLY the queue-order lookup, never
// re-implements source projection.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero provider vocabulary — a queue row is a MediaSourceRecord like any
//    other; source identity (Spotify/Apple Music/local file) lives entirely in
//    the resolved record's existing generic fields (source_kind, provider_ref).
// 2. Missing/empty queue record degrades to natural source order (L083 —
//    maximally capable default; never an error, never a blank screen).
// 3. Unknown ids in the queue (source since deleted/unpublished) are silently
//    skipped rather than throwing, so one stale id can't blank the whole queue.
// 4. Sources not yet queued are appended after the explicit order so nothing
//    in the library becomes unreachable from the Queue surface.
//
// =============================================================================

import {
  findMediaSource,
  readMediaPlaybackData,
  type MediaPlaybackSource,
  type MediaSourceRecord,
} from '../../../read-data/read-media-playback.ts';

export type MediaQueueOrder = {
  ordered_ids: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function payloadOf(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return 'payload' in value ? value.payload : value;
}

function rowsOf(source: MediaPlaybackSource): unknown[] {
  if (Array.isArray(source)) return source;
  if (isRecord(source) && Array.isArray(source.records)) return source.records;
  return [];
}

function readOrderedIds(value: unknown): string[] | undefined {
  if (!isRecord(value) || value.kind !== 'media-queue') return undefined;
  if (!Array.isArray(value.ordered_ids)) return undefined;
  return value.ordered_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}

/** Reads the current queue-order record (empty when none has been written yet). */
export function readMediaQueueOrder(source: MediaPlaybackSource): MediaQueueOrder {
  for (const row of rowsOf(source)) {
    const ids = readOrderedIds(payloadOf(row));
    if (ids) return { ordered_ids: ids };
  }
  return { ordered_ids: [] };
}

/** Resolves the queue order against published sources, appending un-queued sources last. */
export function readMediaQueue(source: MediaPlaybackSource): MediaSourceRecord[] {
  const { sources } = readMediaPlaybackData(source);
  const { ordered_ids } = readMediaQueueOrder(source);
  if (ordered_ids.length === 0) return sources;

  const resolved = ordered_ids.flatMap((id) => {
    const match = findMediaSource(source, id);
    return match ? [match] : [];
  });
  const queuedIds = new Set(resolved.map((item) => item.id));
  const remainder = sources.filter((item) => !queuedIds.has(item.id));
  return [...resolved, ...remainder];
}
