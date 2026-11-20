// tools/show-any-file-as-itself/do-work/media-playback-writes.mjs
//
// The media writes as pure builders: the playback event for one published media source, and the queue order.
// Ported from bitfield-packages packages/media-playback do-work/record-playback-event.ts (8ac9732afa) and
// do-work/reorder-queue.ts (2bb505654b), the parts that check the input and build the record.
//
// What is NOT here: the send. The old files sent the record through the retired Bitfield runtime; the current route is a
// declared send-requests-to-an-engine action for this tool. That action does not exist yet, so nothing here writes.
//
// Invariants (kept from the old files):
// - An event for a media source that is not published is refused, in words.
// - The queue order keeps only non-empty text ids and needs at least one.
// - Only generic ids and kinds go in the record: no provider name.

export function buildPlaybackEvent({ event, media_ref: mediaRef, sources }) {
  if (typeof mediaRef !== 'string' || mediaRef.trim() === '') throw new TypeError('media_ref is required');
  if (event === undefined) throw new TypeError('event is required');
  const source = (sources ?? []).find(item => item.id === mediaRef);
  if (!source) throw new Error(`media source ${mediaRef} is not published`);
  return { kind: 'media-playback-event', media_ref: source.id, event };
}

export function buildQueueOrder(orderedIds) {
  if (!Array.isArray(orderedIds)) throw new TypeError('ordered_ids must be an array');
  const ids = orderedIds.filter(id => typeof id === 'string' && id.trim().length > 0);
  if (ids.length === 0) throw new Error('ordered_ids must contain at least one media id');
  return { kind: 'media-queue', ordered_ids: ids };
}
