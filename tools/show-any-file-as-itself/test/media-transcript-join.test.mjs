// The media transcript join (read-data/media-transcript-join.mjs): the old reader's assertions as tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readMediaTranscriptSegments } from '../read-data/media-transcript-join.mjs';

const seg = (id, transcript_ref, start_ms, text = id) => ({ id, kind: 'transcript-segment', transcript_ref, start_ms, text });
const rows = [
  seg('late', 'tr:lesson-1', 9000),
  seg('early', 'tr:lesson-1', 1000),
  seg('other', 'tr:lesson-2', 500),
];

test('reads the published transcript set directly, without a wrapper', () => {
  const words = readMediaTranscriptSegments(rows, { id: 'm1', transcript_ref: 'tr:lesson-1' });
  assert.deepEqual(words.map(item => item.id), ['early', 'late']);
});

test('joins the media transcript reference to its timestamped words, in start order', () => {
  const words = readMediaTranscriptSegments({ records: rows }, { id: 'm1', transcript_ref: 'tr:lesson-1' });
  assert.deepEqual(words.map(item => item.start_ms), [1000, 9000]);
});

test('does not borrow another media item transcript', () => {
  assert.equal(readMediaTranscriptSegments(rows, { id: 'm3', transcript_ref: 'tr:lesson-3' }), undefined);
});

test('a media item with no transcript_ref has no transcript, not an empty list', () => {
  assert.equal(readMediaTranscriptSegments(rows, { id: 'm4' }), undefined);
});

test('when no direct row matches, the wrapped reader is used, and its answer is kept only when it has rows', () => {
  const readWrapped = (source, ref) => (ref === 'tr:wrapped' ? [seg('w', 'tr:wrapped', 0)] : []);
  assert.deepEqual(readMediaTranscriptSegments([], { transcript_ref: 'tr:wrapped' }, { readWrapped }).map(item => item.id), ['w']);
  assert.equal(readMediaTranscriptSegments([], { transcript_ref: 'tr:none' }, { readWrapped }), undefined);
});
