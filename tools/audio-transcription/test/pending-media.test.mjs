// tools/audio-transcription/test/pending-media.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_NAMES, SEED_SQL, mediaToTranscribe } from '../read-data/pending-media.mjs';

const ID = `1f:${'ab'.repeat(32)}`;
const item = (path, type, extra = {}) => ({ path, type, at: '2026-11-20T10:00:00Z', seconds: 60, bytes: 1000, stored_as: ID, ...extra });

test('a pending seed answers its stored audio and video items, and the octet-stream .MP4 by name', () => {
  const seed = { id: 'seed:1', words: 'pending', media: [item('a.m4a', 'audio/x-m4a'), item('b.mp4', 'video/mp4'), item('C9518.MP4', 'application/octet-stream')] };
  assert.deepEqual(mediaToTranscribe(seed).map(media => media.path), ['a.m4a', 'b.mp4', 'C9518.MP4']);
});

test('an item not stored yet, a non-media type, or a seed whose words are no longer pending is not a candidate', () => {
  const seed = { id: 'seed:2', words: 'pending', media: [item('a.m4a', 'audio/x-m4a', { stored_as: null }), item('notes.pdf', 'application/pdf'), item('x.bin', 'application/octet-stream')] };
  assert.deepEqual(mediaToTranscribe(seed), []);
  assert.deepEqual(mediaToTranscribe({ id: 'seed:3', words: 'done', media: [item('a.m4a', 'audio/x-m4a')] }), []);
});

test('the extension list is data, and the first step reads one seed by its id', () => {
  assert.deepEqual(MEDIA_NAMES, ['.mp4', '.m4a', '.mov', '.wav']);
  assert.match(SEED_SQL, /FROM seeds WHERE id = \$1/);
  assert.deepEqual(mediaToTranscribe(null), []);
});
