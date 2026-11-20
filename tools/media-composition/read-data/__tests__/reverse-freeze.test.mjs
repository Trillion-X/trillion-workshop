/**
 * #76 Reverse + freeze-frame / hold.
 *  - reverse: a set-transform decision carrying `reverse:true` resolves onto the clip transform,
 *    and materialize emits `reverse` onto the EDL clip (video-compose adds reverse + areverse).
 *  - freeze: `freeze:{mode,duration}` (or flat freeze_duration/freeze_mode) holds a frame; the
 *    materialize bridge forwards it so video-compose clones the head/tail frame via tpad.
 * The actual reversed frames / extended duration are proven by the offline render.
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
  const dir = tempFolder(join(tmpdir(), 'revfz-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ctOut = join(dir, 'ct.mjs');
  const meOut = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ctOut}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${meOut}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ctOut));
  ({ materializeExportEdl } = await import(meOut));
});

const oneClip = (transform) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: [{ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters: { transform } }],
  markers: [],
});

test('reverse:true resolves onto the transform', () => {
  const comp = composeTimeline(oneClip({ reverse: true }));
  assert.equal(comp.globalTransform.reverse, true);
});

test('materialize emits reverse onto the EDL clip', () => {
  const comp = composeTimeline(oneClip({ reverse: true }));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  const seg = edl.spine.segments.find((s) => s.reverse === true);
  assert.ok(seg, 'a segment carries reverse into the EDL');
});

test('freeze {mode,duration} resolves onto the transform', () => {
  const comp = composeTimeline(oneClip({ freeze: { mode: 'head', duration: 2 } }));
  assert.deepEqual(comp.globalTransform.freeze, { mode: 'head', duration: 2 });
});

test('flat freeze_duration defaults to a tail hold', () => {
  const comp = composeTimeline(oneClip({ freeze_duration: 1.5 }));
  assert.deepEqual(comp.globalTransform.freeze, { mode: 'tail', duration: 1.5 });
});

test('a non-positive freeze_duration is ignored', () => {
  const comp = composeTimeline(oneClip({ freeze_duration: 0 }));
  assert.equal(comp.globalTransform.freeze, undefined);
});

test('materialize emits freeze onto the EDL clip', () => {
  const comp = composeTimeline(oneClip({ freeze: { mode: 'tail', duration: 1 } }));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  const seg = edl.spine.segments.find((s) => s.freeze);
  assert.ok(seg, 'a segment carries freeze into the EDL');
  assert.deepEqual(seg.freeze, { mode: 'tail', duration: 1 });
});
