// tools/media-composition/test/reframe-camera.test.mjs
//
// The reframe camera (do-work/auto-reframe.mjs planCamera): a subject that wobbles inside the
// frame gets a still crop, a subject that walks across gets a smooth pan no faster than the set speed, and the crop
// window never leaves the picture; a move that does happen carries the blur a shutter would leave on it, and a held shot
// or a cut carries none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planCamera, planMotionBlur, trackToReframe, windowShare } from '../do-work/auto-reframe.mjs';
import CAMERA from '../read-data/reframe-camera.json' with { type: 'json' };

const SOURCE = { width: 1920, height: 1080 };
const steps = (seconds, every, at) => Array.from({ length: Math.round(seconds / every) + 1 }, (_, index) => at(index * every));

test('a 9:16 crop of a 16:9 picture spans 0.316 of its width and all its height', () => {
  const share = windowShare({ aspectW: 9, aspectH: 16, source: SOURCE });
  assert.equal(Math.round(share.w * 1000), 316);
  assert.equal(share.h, 1);
});

test('a subject swinging left and right every half second (sit-ups) gets one still crop', () => {
  // The tracker swings between two points 0.08 of the picture apart, eight readings a second, for a minute.
  const path = steps(60, 0.125, t => ({ t, x: 0.48 + (Math.floor(t / 0.5) % 2 ? 0.08 : 0) + 0.01 * Math.sin(t * 17), y: 0.5 }));
  const track = planCamera(path, { source: SOURCE });
  assert.equal(track.length, 2, 'a held shot is two keyframes');
  assert.equal(track[0].cx, track[1].cx);
  assert.ok(Math.abs(track[0].cx - 0.52) < 0.03);
  assert.ok(track.every(knot => knot.cy === 0.5));
});

test('noisy readings and a short outlier do not move the camera', () => {
  const path = steps(20, 0.125, t => ({ t, x: (t > 9 && t < 9.4) ? 0.95 : 0.3 + 0.02 * Math.sin(t * 31), y: 0.5 }));
  const track = planCamera(path, { source: SOURCE });
  assert.equal(new Set(track.map(knot => knot.cx)).size, 1);
});

test('a subject walking across pans smoothly, never faster than the set speed, and stays in the picture', () => {
  const path = steps(12, 0.125, t => ({ t, x: t < 2 ? 0.2 : t > 8 ? 0.8 : 0.2 + (t - 2) * 0.1, y: 0.5 }));
  const track = planCamera(path, { source: SOURCE });
  const share = windowShare({ aspectW: 9, aspectH: 16, source: SOURCE }).w;
  assert.ok(track.length > 2 && track.length < 40, `a pan is a few keyframes, got ${track.length}`);
  for (let index = 1; index < track.length; index += 1) {
    const speed = Math.abs(track[index].cx - track[index - 1].cx) / (track[index].t - track[index - 1].t);
    assert.ok(speed <= CAMERA.max_speed * share + 1e-3, `speed ${speed}`);
    assert.ok(track[index].cx >= share / 2 - 1e-4 && track[index].cx <= 1 - share / 2 + 1e-4);
  }
  assert.ok(track[0].cx < 0.3 && track[track.length - 1].cx > 0.7, 'the camera ends on the subject');
  // Monotonic: the camera never swings back while the subject only moves one way.
  for (let index = 1; index < track.length; index += 1) assert.ok(track[index].cx >= track[index - 1].cx - 1e-4);
});

test('a subject that jumps across the picture gets a cut, not a swing across it', () => {
  const path = steps(12, 0.125, t => ({ t, x: t < 6 ? 0.2 : 0.8, y: 0.5 }));
  const track = planCamera(path, { source: SOURCE });
  const jump = track.findIndex((knot, index) => index > 0 && knot.cx - track[index - 1].cx > 0.3);
  assert.ok(jump > 0, 'the framing changes side');
  assert.ok(track[jump].t - track[jump - 1].t <= 0.002, `a cut, not a pan: ${track[jump - 1].t} to ${track[jump].t}`);
  assert.ok(track.length <= 8, `two held shots and a cut are a few keyframes, got ${track.length}`);
});

test('the reframe data carries the shape, the planned track and the fill', () => {
  const reframe = trackToReframe([{ t: 0, x: 0.5, y: 0.5 }, { t: 1, x: 0.5, y: 0.5 }], { source: SOURCE, fillMode: 'blur' });
  assert.deepEqual(reframe, { aspect_w: 9, aspect_h: 16, track: [{ t: 0, cx: 0.5, cy: 0.5 }, { t: 1, cx: 0.5, cy: 0.5 }], blur: [], fill_mode: 'blur' });
});

test('a pan carries the smear its speed leaves in one shutter, a held shot and a cut carry none', () => {
  const pan = trackToReframe(steps(12, 0.125, t => ({ t, x: t < 2 ? 0.2 : t > 8 ? 0.8 : 0.2 + (t - 2) * 0.1, y: 0.5 })), { source: SOURCE });
  assert.ok(pan.blur.length >= 1, 'the pan is blurred');
  for (const span of pan.blur) {
    assert.ok(span.to > span.from && span.streak_y === 0);
    assert.ok(span.streak_x >= CAMERA.least_streak && span.streak_x <= CAMERA.max_speed * CAMERA.shutter_seconds + CAMERA.streak_step, `streak ${span.streak_x}`);
    const during = pan.track.filter(knot => knot.t >= span.from && knot.t <= span.to);
    assert.ok(during.length >= 2 && during.at(-1).cx !== during[0].cx, 'blur only where the camera moves');
  }
  assert.ok(pan.blur.every(span => span.from >= 1.5), 'nothing is blurred while the camera holds at the start');
  const held = trackToReframe(steps(60, 0.125, t => ({ t, x: 0.48 + (Math.floor(t / 0.5) % 2 ? 0.08 : 0), y: 0.5 })), { source: SOURCE });
  assert.deepEqual(held.blur, []);
  const cut = trackToReframe(steps(12, 0.125, t => ({ t, x: t < 6 ? 0.2 : 0.8, y: 0.5 })), { source: SOURCE });
  const jump = cut.track.findIndex((knot, index) => index > 0 && knot.cx - cut.track[index - 1].cx > 0.3);
  assert.ok(!cut.blur.some(span => span.from < cut.track[jump].t && span.to > cut.track[jump - 1].t), 'a cut is never smeared');
  assert.deepEqual(planMotionBlur(pan.track, { source: SOURCE, camera: { least_streak: 1 } }), [], 'a smear too small to see is left out');
});

test('without the source size the plan refuses instead of guessing', () => {
  assert.throws(() => planCamera([{ t: 0, x: 0.5, y: 0.5 }], {}), /source picture size/);
});
