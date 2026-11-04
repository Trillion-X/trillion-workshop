// test/hear-in-pieces.test.mjs
// Long sound is heard a minute at a time, because the speech model answers for only part of a long recording: every
// piece is heard, each starts on an MP3 frame, its times are moved to the recording's own seconds, and a silent piece
// is skipped rather than failing the whole recording.
import assert from 'node:assert/strict';
import test from 'node:test';
import { hearInPieces } from '../src/account-transcription.mjs';

const BYTES_PER_SECOND = 8000;
// Constant-rate sound: one 4-byte frame header (0xFF 0xFB, MPEG-1 layer III) every 400 bytes, the rest silence bytes.
const sound = seconds => {
  const bytes = new Uint8Array(seconds * BYTES_PER_SECOND);
  for (let at = 0; at < bytes.length; at += 400) { bytes[at] = 0xff; bytes[at + 1] = 0xfb; }
  return bytes;
};
const decoded = audio => Uint8Array.from(atob(audio), char => char.charCodeAt(0));
const inChunks = (bytes, size) => (async function* chunks() { for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size); })();

test('every minute of a long recording is heard, with times from the start of the recording', async () => {
  const heardSizes = [];
  const ai = { run: async (_model, { audio }) => {
    const piece = decoded(audio);
    heardSizes.push(piece.length);
    assert.equal(piece[0], 0xff, 'each piece starts on a frame header');
    return { text: `piece ${heardSizes.length}`, segments: [{ start: 1, end: 2, text: `piece ${heardSizes.length}`, words: [{ word: 'piece', start: 1, end: 1.5 }] }] };
  } };
  const value = await hearInPieces(ai, inChunks(sound(150), 65536), { pause: async () => {} });
  assert.equal(heardSizes.length, 3);
  assert.equal(heardSizes.reduce((sum, size) => sum + size, 0), 150 * BYTES_PER_SECOND);
  assert.deepEqual(value.segments.map(segment => segment.start), [1, 61, 121]);
  assert.deepEqual(value.segments.map(segment => segment.words[0].start), [1, 61, 121]);
  assert.equal(value.text, 'piece 1 piece 2 piece 3');
});

test('a silent piece is skipped, and a recording with nothing said at all is still a failure', async () => {
  let call = 0;
  const ai = { run: async () => { call += 1; return call <= 4 ? { text: '' } : { text: 'later', segments: [{ start: 0, end: 1, text: 'later' }] }; } };
  const value = await hearInPieces(ai, inChunks(sound(90), 10000), { pause: async () => {} });
  assert.equal(value.text, 'later');
  assert.equal(value.segments[0].start, 60);
  await assert.rejects(hearInPieces({ run: async () => ({ text: '' }) }, inChunks(sound(30), 10000), { pause: async () => {} }), /no transcript text/);
});
