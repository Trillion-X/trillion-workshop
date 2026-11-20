// tools/show-any-file-as-itself/read-data/media-queue-order.ts
//
// The queue order as pure functions over plain rows and sources: no imports, so it runs without the screen reader.
// Ported from bitfield-packages packages/media-playback/read-data/read-media-queue.ts (2bb505654b), the pure half.
//
// Invariants (kept from the old file):
// - Zero provider vocabulary: a queued item is a media source record like any other.
// - No queue record, or an empty one, keeps natural source order: never an error, never a blank list.
// - An id whose source is gone is skipped, so one stale id cannot blank the queue.
// - Sources not queued are appended after the explicit order, so nothing becomes unreachable.

export type MediaQueueOrder = {
  ordered_ids: string[];
};

export type QueuedSource = { id: string };

type QueueRow = { payload?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The first media-queue record's ids; empty when none has been written. */
export function readMediaQueueOrder(rows: readonly QueueRow[]): MediaQueueOrder {
  for (const row of rows) {
    const payload = isRecord(row) && 'payload' in row ? row.payload : row;
    if (!isRecord(payload) || payload.kind !== 'media-queue' || !Array.isArray(payload.ordered_ids)) continue;
    return { ordered_ids: payload.ordered_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) };
  }
  return { ordered_ids: [] };
}

/** Queued ids that exist, in their order, then every other source in its order. */
export function orderMediaQueue<T extends QueuedSource>(sources: readonly T[], orderedIds: readonly string[]): T[] {
  if (orderedIds.length === 0) return [...sources];
  const byId = new Map(sources.map((source) => [source.id, source]));
  const resolved = orderedIds.flatMap((id) => {
    const match = byId.get(id);
    return match ? [match] : [];
  });
  const queued = new Set(resolved.map((source) => source.id));
  return [...resolved, ...sources.filter((source) => !queued.has(source.id))];
}
