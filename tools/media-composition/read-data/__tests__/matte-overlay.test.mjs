/**
 * #84 AI matte / background removal keyed as a video overlay. The generic alpha primitive: a
 * video overlay can be made transparent by a MATTE (grayscale alpha video) via ffmpeg alphamerge.
 * `matte` is a producer key (e.g. 'person') the render runs on the source; matte_ref/matte_path
 * point at an already-produced matte. Person-segmentation is one DATA-selected matte producer.
 * The actual segmentation + composite is proven by the offline render (rembg u2net).
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline, materializeExportEdl;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'matte-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const clip = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: decisions, markers: [],
});
const addOverlay = (params) => ({ action: 'add-overlay', label: 'Matte overlay', span: {}, source_ref: {}, created_at: '2026-08-05T00:00:00.000Z', parameters: params });

test('a matte producer key resolves a video overlay (kind inferred from matte)', () => {
  const comp = composeTimeline(clip([addOverlay({ source_ref: '1f:sub', matte: 'person', x: 0, y: 0 })]));
  const vids = comp.overlays.filter((o) => o.overlay_kind === 'video');
  assert.equal(vids.length, 1);
  assert.equal(vids[0].matte, 'person');
  assert.equal(vids[0].source_ref, '1f:sub');
});

test('an explicit matte_path resolves onto the overlay', () => {
  const comp = composeTimeline(clip([addOverlay({ source_path: '/tmp/sub.mp4', matte_path: '/tmp/matte.mp4' })]));
  const v = comp.overlays.find((o) => o.overlay_kind === 'video');
  assert.equal(v.matte_path, '/tmp/matte.mp4');
});

test('materialize forwards matte + matte_ref onto edl.video_overlays', () => {
  const comp = composeTimeline(clip([addOverlay({ source_ref: '1f:sub', matte: 'person', matte_ref: '1f:m' })]));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  assert.equal(edl.video_overlays.length, 1);
  assert.equal(edl.video_overlays[0].matte, 'person');
  assert.equal(edl.video_overlays[0].matte_ref, '1f:m');
});

test('a plain PiP overlay has no matte (matte is opt-in, backwards compatible)', () => {
  const comp = composeTimeline(clip([addOverlay({ source_ref: '1f:pip', x: 10, y: 10 })]));
  const v = comp.overlays.find((o) => o.overlay_kind === 'video');
  assert.equal(v.matte, undefined);
  assert.equal(v.matte_ref, undefined);
});
