/**
 * #93 Loudness normalization (EBU R128 loudnorm). A clip carries a `loudnorm` target integrated LUFS
 * (-14 social / -16 podcast / -23 broadcast); the composition carries a master-bus `masterLoudnorm`
 * for the finished program. The target is DATA (any LUFS), never a code branch per preset. The knobs
 * flow through the fold + materialize onto the EDL (clip loudnorm + edl.master_loudnorm); the render
 * runs ffmpeg loudnorm. The measured-LUFS shift is proven by the offline suite.
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
  const dir = tempFolder(join(tmpdir(), 'loud-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: decisions,
  markers: [],
});
const dec = (action, parameters) => ({ action, label: action, span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters });

test('a clip loudnorm target flows through the transform + materializes as loudnorm', () => {
  const comp = composeTimeline(view([dec('set-transform', { transform: { loudnorm: -14 } })]));
  assert.equal(comp.globalTransform.loudnorm, -14);
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  const seg = edl.spine.segments.find((s) => s.loudnorm !== undefined);
  assert.ok(seg, 'a segment carries loudnorm');
  assert.equal(seg.loudnorm, -14);
});

test('snake-case target_lufs / loudness_lufs are accepted', () => {
  const a = composeTimeline(view([dec('set-transform', { transform: { target_lufs: -16 } })]));
  assert.equal(a.globalTransform.loudnorm, -16);
  const b = composeTimeline(view([dec('set-transform', { transform: { loudness_lufs: -23 } })]));
  assert.equal(b.globalTransform.loudnorm, -23);
});

test('set-master-loudness sets the composition master-bus target and materializes to master_loudnorm', () => {
  const comp = composeTimeline(view([dec('set-master-loudness', { lufs: -14 })]));
  assert.equal(comp.masterLoudnorm, -14);
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  assert.equal(edl.master_loudnorm, -14);
});

test('set-master-loudness with no target clears it', () => {
  const comp = composeTimeline(view([dec('set-master-loudness', { lufs: -14 }), dec('set-master-loudness', {})]));
  assert.equal(comp.masterLoudnorm, undefined);
});
