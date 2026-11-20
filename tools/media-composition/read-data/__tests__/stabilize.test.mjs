/**
 * #85 Stabilization / deshake as a ClipTransform DATA flag. `stabilize` (boolean) + optional
 * `stabilize_smoothing` / `stabilize_shakiness` knobs resolve onto the transform and materialize
 * forwards them to the EDL clip; video-compose runs the vidstab two-pass. The actual jitter
 * reduction is proven by the offline render (inter-frame motion drops).
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
  const dir = tempFolder(join(tmpdir(), 'stab-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const clip = (t) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: [{ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters: { transform: t } }],
  markers: [],
});

test('a stabilize boolean resolves onto the transform', () => {
  const comp = composeTimeline(clip({ stabilize: true }));
  assert.equal(comp.globalTransform.stabilize, true);
});

test('smoothing + shakiness knobs resolve', () => {
  const comp = composeTimeline(clip({ stabilize: true, stabilize_smoothing: 20, stabilize_shakiness: 6 }));
  assert.equal(comp.globalTransform.stabilizeSmoothing, 20);
  assert.equal(comp.globalTransform.stabilizeShakiness, 6);
});

test('stabilize:false leaves it off', () => {
  const comp = composeTimeline(clip({ stabilize: false }));
  assert.equal(comp.globalTransform.stabilize, false);
});

test('materialize forwards stabilize + smoothing onto the EDL clip (snake_case)', () => {
  const comp = composeTimeline(clip({ stabilize: true, stabilize_smoothing: 15 }));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  const seg = edl.spine.segments.find((s) => s.stabilize);
  assert.ok(seg, 'a segment carries stabilize into the EDL');
  assert.equal(seg.stabilize, true);
  assert.equal(seg.stabilize_smoothing, 15);
});
