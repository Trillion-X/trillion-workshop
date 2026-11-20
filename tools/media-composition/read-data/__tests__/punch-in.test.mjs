/**
 * #88 Auto-zoom / punch-in emphasis. `buildPunchInZoomKeyframes` builds a ZOOM keyframe envelope
 * (hold 1, ramp to zoom, hold, ramp back). It rides the keyframe engine: a set-transform with
 * keyframes.zoom flows through extractTransform + materialize, and the render's `zoom` binding
 * animates it. The visible zoom is proven by the offline render (4x area at 2x zoom).
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline, materializeExportEdl, buildPunchInZoomKeyframes;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'punch-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline, buildPunchInZoomKeyframes } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const clip = (t) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: [{ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters: { transform: t } }],
  markers: [],
});

test('buildPunchInZoomKeyframes ramps 1 -> zoom -> 1 around the chosen time', () => {
  const kf = buildPunchInZoomKeyframes({ at: 1.0, zoom: 1.5, hold: 0.5, ramp: 0.2 });
  assert.deepEqual(kf.map((k) => [k.t, k.value]), [[0, 1], [1.0, 1], [1.2, 1.5], [1.7, 1.5], [1.9, 1]]);
});

test('defaults are sensible (zoom 1.4, hold 1, ramp 0.3)', () => {
  const kf = buildPunchInZoomKeyframes({ at: 0.5 });
  assert.equal(kf[2].value, 1.4);
  assert.equal(kf[2].t, 0.8);       // 0.5 + 0.3 ramp
  assert.equal(kf[3].t, 1.8);       // + 1.0 hold
});

test('a zoom of 1 or less is coerced to the 1.4 default (a punch-in must zoom IN)', () => {
  const kf = buildPunchInZoomKeyframes({ at: 0, zoom: 0.8 });
  assert.equal(kf[2].value, 1.4);
});

test('the zoom envelope flows through the transform + materialize onto the EDL clip', () => {
  const comp = composeTimeline(clip({ keyframes: { zoom: buildPunchInZoomKeyframes({ at: 0.5, zoom: 1.4 }) } }));
  assert.ok(comp.globalTransform.keyframes.zoom.length === 5);
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  const seg = edl.spine.segments.find((s) => s.keyframes && s.keyframes.zoom);
  assert.ok(seg, 'a segment carries the zoom keyframes into the EDL');
  assert.equal(seg.keyframes.zoom[2].value, 1.4);
});
