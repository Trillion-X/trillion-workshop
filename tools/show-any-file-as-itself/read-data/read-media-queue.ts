// tools/show-any-file-as-itself/read-data/read-media-queue.ts
//
// The queue as the screen reads it: the published media sources in the order the one media-queue record names.
// The order rules are in ./media-queue-order.ts. The write that stores the order is not here yet (see the
// verify-every-port row for show-any-file-as-itself).

import { readMediaPlaybackData, type MediaSourceRecord } from './read-media-playback';
import { readScreenReadyRecords } from '../../screen-ready-records/read-data/read-screen-ready-records';
import { orderMediaQueue, readMediaQueueOrder } from './media-queue-order';

/** The queue as the screen reads it, from the same screen-ready source the media reader uses. */
export function readMediaQueue(source: unknown): MediaSourceRecord[] {
  const { sources } = readMediaPlaybackData(source);
  const { ordered_ids } = readMediaQueueOrder(readScreenReadyRecords(source).records);
  return orderMediaQueue(sources, ordered_ids);
}
