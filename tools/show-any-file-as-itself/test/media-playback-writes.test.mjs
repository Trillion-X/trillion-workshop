// The media writes as builders (do-work/media-playback-writes.mjs): the old record and queue invariants as tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlaybackEvent, buildQueueOrder } from '../do-work/media-playback-writes.mjs';

const sources = [{ id: 'a' }, { id: 'b' }];

test('a playback event is kept for a published source, by its id, with no provider name in the record', () => {
  assert.deepEqual(buildPlaybackEvent({ event: { at_ms: 1200 }, media_ref: 'b', sources }), {
    kind: 'media-playback-event', media_ref: 'b', event: { at_ms: 1200 },
  });
});

test('an event for a source that is not published is refused in words', () => {
  assert.throws(() => buildPlaybackEvent({ event: {}, media_ref: 'gone', sources }), /media source gone is not published/);
});

test('an event needs a media_ref and an event', () => {
  assert.throws(() => buildPlaybackEvent({ event: {}, media_ref: '  ', sources }), /media_ref is required/);
  assert.throws(() => buildPlaybackEvent({ media_ref: 'a', sources }), /event is required/);
});

test('the queue keeps only non-empty text ids, in order', () => {
  assert.deepEqual(buildQueueOrder(['b', 7, '  ', 'a']), { kind: 'media-queue', ordered_ids: ['b', 'a'] });
});

test('the queue needs an array with at least one media id', () => {
  assert.throws(() => buildQueueOrder('a'), /ordered_ids must be an array/);
  assert.throws(() => buildQueueOrder([' ', 3]), /must contain at least one media id/);
});
