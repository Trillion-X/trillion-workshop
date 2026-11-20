/**
 * #95 Smooth slow-mo (optical-flow frame interpolation). A clip carries a `speedSmooth` boolean;
 * when the clip is SLOWED (speed<1) the render regenerates the in-between frames with ffmpeg
 * minterpolate (motion-compensated interpolation, the DaVinci Optical Flow / Twixtor look) instead
 * of duplicating frames. The flag is DATA over the SAME speed seam (L069); the render is blind.
 * speedSmooth flows through the fold + materialize (speed_smooth) onto the EDL clip; the offline
 * suite proves the interpolated output has NO duplicate consecutive frames.
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
  const dir = tempFolder(join(tmpdir(), 'slowmo-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const view = (t) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: [{ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters: { transform: t } }],
  markers: [],
});

test('speedSmooth rides onto the transform with the speed', () => {
  const comp = composeTimeline(view({ speed: 0.5, speedSmooth: true }));
  assert.equal(comp.globalTransform.speed, 0.5);
  assert.equal(comp.globalTransform.speedSmooth, true);
});

test('snake-case speed_smooth is accepted', () => {
  const comp = composeTimeline(view({ speed: 0.5, speed_smooth: true }));
  assert.equal(comp.globalTransform.speedSmooth, true);
});

test('speedSmooth materializes onto the EDL clip as speed_smooth', () => {
  const comp = composeTimeline(view({ speed: 0.5, speedSmooth: true }));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  const seg = edl.spine.segments.find((s) => s.speed_smooth);
  assert.ok(seg, 'a segment carries speed_smooth');
  assert.equal(seg.speed, 0.5);
  assert.equal(seg.speed_smooth, true);
});
