/**
 * #89 Loop / boomerang segment. A `set-transform` with `loop_count` (and optional
 * `loop_boomerang`) repeats a clip N times; boomerang reverses every odd copy so the motion
 * ping-pongs. The knobs flow through extractTransform (camelCase loopCount/loopBoomerang) and
 * materialize (snake loop_count/loop_boomerang) onto the EDL clip; the render concats N copies.
 * The looped duration (N x the clip) is proven by the offline render in the loop suite runner.
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
  const dir = tempFolder(join(tmpdir(), 'loop-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const clip = (params) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: [{ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters: params }],
  markers: [],
});

test('loop_count > 1 sets loopCount on the transform; boomerang flag rides along', () => {
  const comp = composeTimeline(clip({ transform: { loopCount: 3, loopBoomerang: true } }));
  assert.equal(comp.globalTransform.loopCount, 3);
  assert.equal(comp.globalTransform.loopBoomerang, true);
});

test('snake-case loop_count / loop_boomerang params are accepted (and floored)', () => {
  const comp = composeTimeline(clip({ transform: { loop_count: 2.9, loop_boomerang: true } }));
  assert.equal(comp.globalTransform.loopCount, 2);
  assert.equal(comp.globalTransform.loopBoomerang, true);
});

test('loop_count <= 1 is a no-op (no repeat authored)', () => {
  const comp = composeTimeline(clip({ transform: { loopCount: 1 } }));
  assert.equal(comp.globalTransform.loopCount, undefined);
});

test('the loop knobs materialize onto the EDL clip as snake_case', () => {
  const comp = composeTimeline(clip({ transform: { loopCount: 2, loopBoomerang: true } }));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  const seg = edl.spine.segments.find((s) => s.loop_count);
  assert.ok(seg, 'a segment carries loop_count into the EDL');
  assert.equal(seg.loop_count, 2);
  assert.equal(seg.loop_boomerang, true);
});
