/**
 * #102 Speed-ramp velocity curve. Proves the DATA path: a `speed_ramp` [{t,speed}] keyframe
 * array (+ `speed_ramp_unit`) set via set-transform folds onto the clip transform (sanitized),
 * and materializes onto the EDL clip row as `speed_ramp`/`speed_ramp_unit`, which video-compose
 * maps blind to setpts=(f(T))/TB. Presets are fraction-domain DATA rows (SPEED_RAMP_CATALOG).
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline, materializeExportEdl, SPEED_RAMP_CATALOG, TEXT_MOTION_CATALOG;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'ramp-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline, SPEED_RAMP_CATALOG, TEXT_MOTION_CATALOG } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const viewWith = (params) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 'c1', label: 'Clip', start: 0, end: 5, source_ref: { artifact_ref: 'c.mp4', source_id: 'c1' } },
  ] }],
  editDecisions: [{ action: 'set-transform', source_ref: { source_id: 'c1' }, parameters: params, created_at: 'x' }],
  markers: [],
});

const overlayView = (params) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 'c1', label: 'Clip', start: 0, end: 5, source_ref: { artifact_ref: 'c.mp4', source_id: 'c1' } },
  ] }],
  editDecisions: [{ action: 'add-overlay', parameters: { overlay_kind: 'text', text: 'Hi', ...params }, created_at: 'x' }],
  markers: [],
});

test('speed_ramp DATA folds onto the clip transform, sanitized (junk points dropped)', () => {
  const comp = composeTimeline(viewWith({
    speed_ramp: [{ t: 0, speed: 2 }, { t: 2, speed: 0.5 }, { t: 'x', speed: 1 }, { t: 3, speed: -1 }, null],
    speed_ramp_unit: 'seconds',
  }));
  const clip = comp.lanes.flatMap((l) => l.clips)[0];
  assert.deepEqual(clip.transform.speedRamp, [{ t: 0, speed: 2 }, { t: 2, speed: 0.5 }]);
  assert.equal(clip.transform.speedRampUnit, 'seconds');
});

test('junk-only ramp DATA fails closed (no speedRamp on the transform)', () => {
  const comp = composeTimeline(viewWith({ speed_ramp: [{ t: NaN, speed: 0 }, 'nope'] }));
  const clip = comp.lanes.flatMap((l) => l.clips)[0];
  assert.equal(clip.transform.speedRamp, undefined);
});

test('materialize renames speedRamp/speedRampUnit to snake_case on the EDL clip row', () => {
  const comp = composeTimeline(viewWith({
    speed_ramp: [{ t: 0, speed: 3 }, { t: 0.6, speed: 1 }],
    speed_ramp_unit: 'fraction',
  }));
  const { edl } = materializeExportEdl(comp, () => '/tmp/c.mp4', {});
  const seg = edl.spine.segments.find((s) => s.kind === 'clip');
  assert.deepEqual(seg.speed_ramp, [{ t: 0, speed: 3 }, { t: 0.6, speed: 1 }]);
  assert.equal(seg.speed_ramp_unit, 'fraction');
});

test('preset catalog rows are fraction-domain velocity curves', () => {
  assert.ok(Object.keys(SPEED_RAMP_CATALOG).length >= 4);
  for (const ramp of Object.values(SPEED_RAMP_CATALOG)) {
    for (const p of ramp) {
      assert.ok(p.t >= 0 && p.t <= 1, 'fraction t');
      assert.ok(p.speed > 0, 'positive speed');
    }
  }
});

// #106 Generic pass-through: a NOVEL camelCase transform field reaches the EDL clip row as
// snake_case with ZERO materialize-edl edits (the closed rename map is gone). UI-only keys stay out.
test('novel transform fields pass through generically; UI-only keys are excluded', () => {
  const comp = composeTimeline(viewWith({}));
  const clip = comp.lanes.flatMap((l) => l.clips)[0];
  clip.transform = { ...clip.transform, someBrandNewEffect: { level: 3 }, framePreset: 'wide', speed_pct: 50 };
  const { edl } = materializeExportEdl(comp, () => '/tmp/c.mp4', {});
  const seg = edl.spine.segments.find((s) => s.kind === 'clip');
  assert.deepEqual(seg.some_brand_new_effect, { level: 3 });
  assert.equal(seg.frame_preset, undefined);
  assert.equal(seg.framePreset, undefined);
  assert.equal(seg.speed_pct, undefined);
});

// #107 speed_ramp_audio opts the clip audio into ramp retiming; folds + materializes as DATA.
test('speed_ramp_audio folds onto the transform and materializes snake_case', () => {
  const comp = composeTimeline(viewWith({
    speed_ramp: [{ t: 0, speed: 2 }], speed_ramp_audio: true,
  }));
  const clip = comp.lanes.flatMap((l) => l.clips)[0];
  assert.equal(clip.transform.speedRampAudio, true);
  const { edl } = materializeExportEdl(comp, () => '/tmp/c.mp4', {});
  const seg = edl.spine.segments.find((s) => s.kind === 'clip');
  assert.equal(seg.speed_ramp_audio, true);
});

// #108 An adjustment clip (adjustment:true + grade) becomes a time-scoped adjustment_layers
// window instead of a spine segment; its lane position IS the effect window.
test('adjustment clip materializes as an adjustment_layers window, not a segment', () => {
  const comp = composeTimeline(viewWith({ adjustment: true, grade: 'hue=s=0' }));
  const { edl } = materializeExportEdl(comp, () => '/tmp/c.mp4', {});
  assert.equal(edl.spine.segments.filter((s) => s.kind === 'clip').length, 0);
  assert.deepEqual(edl.adjustment_layers, [{ start: 0, end: 5, filter: 'hue=s=0' }]);
});

// #109 A strength keyframe envelope on an adjustment clip materializes onto the layer entry,
// offset from clip-local to global program time by the clip's lane position.
test('adjustment strength keyframes materialize offset to global time', () => {
  const comp = composeTimeline(viewWith({
    adjustment: true, grade: 'hue=s=0',
    keyframes: { strength: [{ t: 0, value: 0 }, { t: 2.5, value: 1 }] },
  }));
  const { edl } = materializeExportEdl(comp, () => '/tmp/c.mp4', {});
  assert.deepEqual(edl.adjustment_layers[0].strength_keyframes,
    [{ t: 0, value: 0 }, { t: 2.5, value: 1 }]);
});

// AUDIT-FIX B: a clip caption must materialize as the clip `label` (the field video-compose burns),
// not leak as `caption`. Previously it rode through the generic pass-through as `caption` and never rendered.
test('clip caption materializes as segment.label (not caption)', () => {
  const comp = composeTimeline(viewWith({ caption_text: 'HELLO', caption_x: 0.25, caption_y: 0.4 }));
  const { edl } = materializeExportEdl(comp, () => '/tmp/c.mp4', {});
  const seg = edl.spine.segments.find((s) => s.kind === 'clip');
  assert.equal(seg.caption, undefined, 'caption must not leak onto the row');
  assert.ok(seg.label && seg.label.text === 'HELLO', 'caption becomes the burned label');
});

// AUDIT-FIX C: a clip transition (in-blend) must aggregate into the positional edl.spine.transitions
// array (gap i = segment i+1's transition), not leak onto the clip row.
test('clip transition aggregates into edl.spine.transitions', () => {
  const two = {
    lanes: [{ lane_id: 'v', role: 'video', label: 'V', items: [
      { item_id: 'c1', label: 'A', start: 0, end: 2, source_ref: { artifact_ref: 'a.mp4', source_id: 'c1' } },
      { item_id: 'c2', label: 'B', start: 2, end: 4, source_ref: { artifact_ref: 'b.mp4', source_id: 'c2' } },
    ] }],
    editDecisions: [{ action: 'set-transform', source_ref: { source_id: 'c2' }, parameters: { transition_type: 'fade', transition_duration: 1 }, created_at: 'x' }],
    markers: [],
  };
  const comp = composeTimeline(two);
  const { edl } = materializeExportEdl(comp, (id) => `/tmp/${id}.mp4`, {});
  assert.equal(edl.spine.segments[0].transition, undefined, 'transition must not leak onto a clip row');
  assert.equal(edl.spine.segments[1].transition, undefined);
  assert.ok(Array.isArray(edl.spine.transitions), 'transitions array built');
  assert.equal(edl.spine.transitions.length, 1, 'one gap for two clips');
  assert.equal(edl.spine.transitions[0].type, 'fade');
  assert.equal(edl.spine.transitions[0].duration, 1);
});

// #109 An adjustment clip's strength keyframes materialize (offset clip-local -> global time) onto
// the adjustment_layers entry so the render can blend the look intensity over the window.
test('adjustment strength keyframes materialize onto the layer, offset to global time', () => {
  const comp = composeTimeline(viewWith({
    adjustment: true, grade: 'hue=s=0',
    keyframes: { strength: [{ t: 0, value: 0 }, { t: 2.5, value: 1 }] },
  }));
  const { edl } = materializeExportEdl(comp, () => '/tmp/c.mp4', {});
  assert.deepEqual(edl.adjustment_layers?.[0]?.strength_keyframes,
    [{ t: 0, value: 0 }, { t: 2.5, value: 1 }]);
});

// #112 Easing is a config of the ONE piecewise primitive: a keyframe with interp:'ease-in' flows
// through composeTimeline unchanged (the render maps it to a cubic fraction remap). Linear default
// stays untouched (byte-identical prior form). This proves the DATA path carries the interp.
test('keyframe interp (easing) survives the DATA path onto the clip transform', () => {
  const comp = composeTimeline(viewWith({
    keyframes: { opacity: [{ t: 0, value: 0 }, { t: 2, value: 1, interp: 'ease-in' }] },
  }));
  const clip = comp.lanes.flatMap((l) => l.clips)[0];
  assert.equal(clip.transform.keyframes.opacity[1].interp, 'ease-in');
});

// #113 Multi-stop Ken Burns: the nested ken_burns.keyframes {zoom,cx,cy:[{t,value,interp?}]} and the
// `unit` survive the DATA path (extractTransform preserves them, no flat-key enumeration), and the
// whole kenBurns object materializes to the EDL clip's `ken_burns` for the render's piecewiseExpr.
test('ken_burns.keyframes (multi-stop) folds and materializes to the EDL ken_burns', () => {
  const comp = composeTimeline(viewWith({
    ken_burns: { keyframes: { zoom: [{ t: 0, value: 1 }, { t: 1.5, value: 2, interp: 'ease-in' }, { t: 3, value: 1 }] }, unit: 'seconds' },
  }));
  const clip = comp.lanes.flatMap((l) => l.clips)[0];
  assert.equal(clip.transform.kenBurns.keyframes.zoom[1].value, 2);
  assert.equal(clip.transform.kenBurns.keyframes.zoom[1].interp, 'ease-in');
  assert.equal(clip.transform.kenBurns.unit, 'seconds');
  const { edl } = materializeExportEdl(comp, () => '/tmp/c.mp4', {});
  const seg = edl.spine.segments.find((s) => s.kind === 'clip');
  assert.deepEqual(seg.ken_burns.keyframes.zoom[2], { t: 3, value: 1 });
  assert.equal(seg.ken_burns.unit, 'seconds');
});

// #114 Split edit (J-cut / L-cut): one scalar `audio_offset_s` folds to the transform (audioOffsetS)
// and materializes to the EDL clip row as `audio_offset_s` via the generic camel->snake pass-through
// (zero materialize edits). Negative = J-cut (audio leads), positive = L-cut (audio lags).
test('audio_offset_s (split edit) folds to audioOffsetS and materializes snake_case', () => {
  const comp = composeTimeline(viewWith({ audio_offset_s: -0.8 }));
  const clip = comp.lanes.flatMap((l) => l.clips)[0];
  assert.equal(clip.transform.audioOffsetS, -0.8);
  const { edl } = materializeExportEdl(comp, () => '/tmp/c.mp4', {});
  const seg = edl.spine.segments.find((s) => s.kind === 'clip');
  assert.equal(seg.audio_offset_s, -0.8);
});

// L-cut sign + camelCase authoring both reach the EDL the same way (one scalar, both cut types).
test('positive audioOffsetS (L-cut) authored camelCase also materializes', () => {
  const comp = composeTimeline(viewWith({ audioOffsetS: 0.6 }));
  const { edl } = materializeExportEdl(comp, () => '/tmp/c.mp4', {});
  const seg = edl.spine.segments.find((s) => s.kind === 'clip');
  assert.equal(seg.audio_offset_s, 0.6);
});

// #115 Text overlay entrance/exit MOTION. A named `enter` preset (TEXT_MOTION_CATALOG) is expanded by
// materialize into a per-axis piecewiseExpr envelope over the overlay's window; the render owns the
// compile. slide-left => an x envelope from off-rest to rest; explicit keyframes win per axis.
test('enter:slide-left preset expands to an x keyframe envelope on the EDL overlay', () => {
  const comp = composeTimeline(overlayView({ x: 0.5, y: 0.5, start: 1, end: 4, enter: 'slide-left', enter_dur: 0.5 }));
  const { edl } = materializeExportEdl(comp, () => null, {});
  const ov = edl.text_overlays[0];
  assert.ok(Array.isArray(ov.keyframes.x), 'x envelope present');
  // rest x = 0.5, slide-left starts 1.2 left of rest (-0.7) at t=start(1), settles to 0.5 at t=1.5
  assert.equal(ov.keyframes.x[0].t, 1);
  assert.equal(ov.keyframes.x[0].value, -0.7);
  assert.equal(ov.keyframes.x[ov.keyframes.x.length - 1].t, 1.5);
  assert.equal(ov.keyframes.x[ov.keyframes.x.length - 1].value, 0.5);
});

test('exit:fade preset expands to an alpha envelope over the window tail', () => {
  const comp = composeTimeline(overlayView({ x: 0.5, y: 0.5, start: 0, end: 3, exit: 'fade', exit_dur: 0.5 }));
  const { edl } = materializeExportEdl(comp, () => null, {});
  const ov = edl.text_overlays[0];
  assert.ok(Array.isArray(ov.keyframes.alpha));
  // exit reverses: at t=end-dur(2.5) alpha=1 (settled), at t=end(3) alpha=0 (faded out)
  assert.deepEqual(ov.keyframes.alpha, [{ t: 2.5, value: 1 }, { t: 3, value: 0 }]);
});

test('explicit overlay keyframes pass through and override a preset per axis', () => {
  const comp = composeTimeline(overlayView({ x: 0.5, y: 0.5, start: 0, end: 3, enter: 'slide-left',
    keyframes: { x: [{ t: 0, value: -0.9 }, { t: 1, value: 0.5 }] } }));
  const { edl } = materializeExportEdl(comp, () => null, {});
  const ov = edl.text_overlays[0];
  assert.deepEqual(ov.keyframes.x, [{ t: 0, value: -0.9 }, { t: 1, value: 0.5 }]);
});

test('a static overlay (no motion) emits no keyframes (byte-identical path)', () => {
  const comp = composeTimeline(overlayView({ x: 0.5, y: 0.5, start: 0, end: 3 }));
  const { edl } = materializeExportEdl(comp, () => null, {});
  assert.equal(edl.text_overlays[0].keyframes, undefined);
});

test('TEXT_MOTION_CATALOG rows are DATA shapes (axis + normalized-time knots)', () => {
  assert.ok(Object.keys(TEXT_MOTION_CATALOG).length >= 5);
  for (const preset of Object.values(TEXT_MOTION_CATALOG)) {
    assert.ok(['x', 'y', 'alpha'].includes(preset.axis));
    for (const k of preset.knots) assert.ok(k.t >= 0 && k.t <= 1, 'normalized motion-time');
  }
});

// #116 Animated rotation: keyframes.rotate is a keyframed DEGREES envelope that the render's rotate
// KEYFRAME_BINDINGS row compiles to an ffmpeg rotate filter (one row, L090). The DATA path is the
// generic keyframes pass-through (like opacity/#112), so the envelope reaches the EDL clip verbatim.
test('keyframes.rotate (animated rotation) survives the DATA path onto the clip transform', () => {
  const comp = composeTimeline(viewWith({
    keyframes: { rotate: [{ t: 0, value: 0 }, { t: 2, value: 90, interp: 'ease-in-out' }] },
  }));
  const clip = comp.lanes.flatMap((l) => l.clips)[0];
  assert.deepEqual(clip.transform.keyframes.rotate, [{ t: 0, value: 0 }, { t: 2, value: 90, interp: 'ease-in-out' }]);
  const { edl } = materializeExportEdl(comp, () => '/tmp/c.mp4', {});
  const seg = edl.spine.segments.find((s) => s.kind === 'clip');
  assert.deepEqual(seg.keyframes.rotate, [{ t: 0, value: 0 }, { t: 2, value: 90, interp: 'ease-in-out' }]);
});
