/**
 * file: packages/media-composition/do-work/__tests__/author-concat-edl.test.mjs
 *
 * Tests `authorConcatEdl` — the generic "windows → base_span concat EDL" author.
 * Given ONE base video artifact + a list of [start,end] windows (in seconds), it
 * emits the render EDL that `video-compose.mjs` consumes: a spine of `base_span`
 * segments, chronologically ordered, one per window. It names NO domain — a tennis
 * highlight reel, a lecture recap, a bug-repro montage all author through it; the
 * "which windows" decision is UPSTREAM (the progression-evaluator selection
 * pipeline: derive-spans → constrained-span-pack, proven in csp01/csp02). This is
 * the L098 translation boundary: the caller hands over windows and receives an
 * EDL, without needing to know the EDL's internal field names (src_in/base_span).
 *
 * Two layers: (1) PURE unit tests of the emitted EDL shape; (2) it consumes the
 * EXACT constrained-span-pack output shape ({id,start,end,score,category}).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authorConcatEdl } from '../author-concat-edl.mjs';

const BASE = '/clips/match-2026-07-01.mp4';

test('authorConcatEdl — windows → base_span spine, chronological, correct src_in/src_out + base artifact', () => {
  const { edl, segmentCount, totalDurationS } = authorConcatEdl({
    baseArtifact: BASE,
    windows: [{ start: 20, end: 24 }, { start: 2, end: 4.5 }], // out of order
  });
  assert.equal(edl.base.kind, 'video');
  assert.equal(edl.base.artifact, BASE);
  assert.equal(segmentCount, 2);
  assert.deepEqual(edl.spine.segments.map((s) => [s.kind, s.src_in, s.src_out]), [
    ['base_span', 2, 4.5],   // chronological
    ['base_span', 20, 24],
  ]);
  assert.equal(totalDurationS, 6.5); // 2.5 + 4
});

test('authorConcatEdl — consumes the EXACT constrained-span-pack output shape ({id,start,end,score,category})', () => {
  // This is verbatim what deriveMeasure(..., constrained-span-pack).value.selected returns.
  const selected = [
    { id: 'b1', start: 2, end: 4.5, score: 0.95, category: 'bounce' },
    { id: 'b3', start: 19, end: 21.5, score: 0.9, category: 'bounce' },
  ];
  const { edl, segmentCount } = authorConcatEdl({ baseArtifact: BASE, windows: selected });
  assert.equal(segmentCount, 2);
  assert.deepEqual(edl.spine.segments.map((s) => s.src_in), [2, 19]);
});

test('authorConcatEdl — invalid windows (end<=start / non-numeric) are skipped with a reason', () => {
  const { edl, segmentCount, skipped } = authorConcatEdl({
    baseArtifact: BASE,
    windows: [{ start: 0, end: 4 }, { start: 5, end: 5 }, { start: 'x', end: 3 }],
  });
  assert.equal(segmentCount, 1);
  assert.equal(edl.spine.segments[0].src_in, 0);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((s) => s.reason === 'invalid-window'));
});

test('authorConcatEdl — per-window overlaySource → overlays riding the window (at_src/end_src)', () => {
  const { edl } = authorConcatEdl({
    baseArtifact: BASE,
    windows: [{ start: 2, end: 4.5, overlaySource: '/ov/68mph.png' }, { start: 10, end: 12 }],
  });
  assert.equal(edl.overlays.length, 1);
  assert.deepEqual(
    { src: edl.overlays[0].source, at: edl.overlays[0].at_src, end: edl.overlays[0].end_src },
    { src: '/ov/68mph.png', at: 2, end: 4.5 },
  );
});

test('authorConcatEdl — encode passthrough (width/height/fps ride onto the EDL)', () => {
  const { edl } = authorConcatEdl({
    baseArtifact: BASE,
    windows: [{ start: 0, end: 2 }],
    encode: { width: 1080, height: 1920, fps: 30 },
  });
  assert.deepEqual(edl.encode, { width: 1080, height: 1920, fps: 30 });
});

test('authorConcatEdl — empty windows → empty spine, zero duration, no overlays key', () => {
  const { edl, segmentCount, totalDurationS } = authorConcatEdl({ baseArtifact: BASE, windows: [] });
  assert.equal(segmentCount, 0);
  assert.deepEqual(edl.spine.segments, []);
  assert.equal(totalDurationS, 0);
  assert.equal(edl.overlays, undefined);
});

test('authorConcatEdl — baseArtifact is required (fail-closed, no EDL with an undefined base)', () => {
  assert.throws(() => authorConcatEdl({ windows: [{ start: 0, end: 2 }] }), /baseArtifact/);
});
