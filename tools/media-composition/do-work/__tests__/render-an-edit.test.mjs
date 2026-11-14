/**
 * file: packages/media-composition/do-work/__tests__/render-an-edit.test.mjs
 *
 * Tests `editWithItsOwnSize`: an edit that names no picture size and opens on a video clip renders at that clip's own
 * size (a portrait phone video was being stretched onto a 1920x1080 frame by change-speed-over-a-range), while an edit
 * that names a size, or opens on something that is not a video clip, is left exactly as written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { editWithItsOwnSize } from '../render-an-edit.mjs';

const clip = { kind: 'clip', id: 'a', source: 'https://files.example/video.mp4', in: 0, out: 2 };

test('an edit that names no size and opens on a clip keeps the clip size, other encode settings intact', () => {
  const edl = { encode: { crf: 20 }, spine: { segments: [clip] } };
  assert.deepEqual(editWithItsOwnSize(edl).encode, { crf: 20, resolution: 'source' });
  assert.deepEqual(editWithItsOwnSize({ spine: { segments: [clip] } }).encode, { resolution: 'source' });
});

test('an edit that names a size in any of the three ways is returned unchanged', () => {
  for (const encode of [{ resolution: '4k' }, { width: 1080 }, { height: 1920 }, { width: 720, height: 1280 }]) {
    const edl = { encode, spine: { segments: [clip] } };
    assert.equal(editWithItsOwnSize(edl), edl);
  }
});

test('an edit that opens on something other than a video clip is returned unchanged', () => {
  for (const first of [{ kind: 'base_span', in: 0, out: 1 }, { kind: 'color', color: 'black', duration: 1 }, { kind: 'clip', id: 'b' }]) {
    const edl = { spine: { segments: [first, clip] } };
    assert.equal(editWithItsOwnSize(edl), edl);
  }
  const empty = { spine: { segments: [] } };
  assert.equal(editWithItsOwnSize(empty), empty);
});
