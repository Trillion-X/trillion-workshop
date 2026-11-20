/**
 * #73 Color grade / look: a set-transform decision carrying `grade` (opaque ffmpeg string) OR a
 * `look` preset key resolves onto the clip transform via composeTimeline, and the materialize
 * bridge emits `grade`/`grade_lut_ref` onto the EDL clip so video-compose applies it. The render
 * itself (grade string -> desaturated output) is proven by the offline render.
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
  const dir = tempFolder(join(tmpdir(), 'grade-'));
  const ctOut = join(dir, 'ct.mjs');
  const meOut = join(dir, 'me.mjs');
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ctOut}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${meOut}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ctOut));
  ({ materializeExportEdl } = await import(meOut));
});

const view = (transform) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4' } }] }],
  editDecisions: [{ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters: { transform } }],
  markers: [],
});

test('a look preset resolves to its opaque grade string', () => {
  const comp = composeTimeline(view({ look: 'black-white' }));
  assert.equal(comp.globalTransform.grade, 'hue=s=0', 'black-white maps to hue=s=0');
});

test('an explicit grade string wins over a look preset', () => {
  const comp = composeTimeline(view({ grade: 'eq=contrast=2', look: 'vibrant' }));
  assert.equal(comp.globalTransform.grade, 'eq=contrast=2', 'explicit grade takes precedence');
});

test("look 'none' clears the grade", () => {
  const comp = composeTimeline(view({ look: 'none' }));
  assert.equal(comp.globalTransform.grade, '', 'none clears to empty grade');
});

test('materialize emits grade + grade_lut_ref on the EDL clip', () => {
  const comp = composeTimeline(view({ grade: '${LUT}', grade_lut_ref: '1f:deadbeef' }));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 1280, height: 720 });
  const seg = edl.spine.segments.find((s) => s.grade);
  assert.ok(seg, 'a segment carries grade into the EDL');
  assert.equal(seg.grade, '${LUT}');
  assert.equal(seg.grade_lut_ref, '1f:deadbeef', 'LUT ref carried through');
});

test('ordered grade layers retain independent LUT identities through the materializer', () => {
  const layers=[{grade:'lut3d=${LUT}',grade_lut_ref:'package::media-composition::stored-bytes::first'},{grade:'eq=contrast=1.1'},{grade:'lut3d=${LUT}',grade_lut_ref:'package::media-composition::stored-bytes::second'}];
  const comp=composeTimeline(view({grade_layers:layers}));
  const {edl}=materializeExportEdl(comp,()=> 'clip.mp4',{width:160,height:90});
  assert.deepEqual(edl.spine.segments.find(s=>s.grade_layers).grade_layers,layers);
  assert.throws(()=>composeTimeline(view({grade_layers:[{grade:3}]})),/color layers/);
});
