/**
 * #94 Aspect-fill blurred background. The auto-reframe primitive gains a `fill_mode`: 'crop' (cover,
 * default), 'blur' (contain-fit the whole frame + fill the bars with a scaled blurred copy of itself,
 * the Instagram/CapCut vertical look, no black bars), or a solid pad color. The mode is DATA over the
 * SAME reframe primitive (L069); the crop math is untouched. fill_mode/fill_blur flow through the fold
 * onto the reframe object, which materialize passes to the EDL. The pixel effect is proven offline.
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
  const dir = tempFolder(join(tmpdir(), 'reframe-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const view = (params) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: [{ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters: params }],
  markers: [],
});

test('fill_mode + fill_blur ride onto the reframe transform', () => {
  const comp = composeTimeline(view({ transform: { reframe: { aspect_w: 9, aspect_h: 16, fill_mode: 'blur', fill_blur: 30 } } }));
  assert.equal(comp.globalTransform.reframe.fill_mode, 'blur');
  assert.equal(comp.globalTransform.reframe.fill_blur, 30);
});

test('the reframe fill_mode materializes onto the EDL clip reframe object', () => {
  const comp = composeTimeline(view({ transform: { reframe: { aspect_w: 9, aspect_h: 16, fill_mode: 'blur' } } }));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 360, height: 640 });
  const seg = edl.spine.segments.find((s) => s.reframe && s.reframe.fill_mode);
  assert.ok(seg, 'a segment carries the reframe fill_mode');
  assert.equal(seg.reframe.fill_mode, 'blur');
});

test('a color fill_mode is accepted (solid pad instead of blur)', () => {
  const comp = composeTimeline(view({ transform: { reframe: { fill_mode: 'white' } } }));
  assert.equal(comp.globalTransform.reframe.fill_mode, 'white');
});
