/**
 * #75 Noise reduction + detach audio.
 *  - denoise: a set-transform decision carrying `denoise` (opaque ffmpeg audio-filter string)
 *    OR a `denoise_preset` key resolves onto the clip transform via composeTimeline, and the
 *    materialize bridge emits `denoise` onto the EDL clip so video-compose applies it (afilter
 *    in-graph, or the deepfilternet external-method key). The actual noise-floor drop is proven
 *    by the offline afftdn render.
 *  - detach-audio: silences the target video clip (transform.muted -> EDL silent_audio) and
 *    spawns a copy of it on a dedicated audio lane so the sound can be edited independently.
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
  const dir = tempFolder(join(tmpdir(), 'denoise-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ctOut = join(dir, 'ct.mjs');
  const meOut = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ctOut}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${meOut}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ctOut));
  ({ materializeExportEdl } = await import(meOut));
});

const oneClip = (editDecisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions,
  markers: [],
});
const setDenoise = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters: { transform: params } });

test('an explicit denoise afilter string resolves onto the clip transform', () => {
  const comp = composeTimeline(oneClip([setDenoise({ denoise: 'afftdn=nf=-25' })]));
  assert.equal(comp.globalTransform.denoise, 'afftdn=nf=-25');
});

test('a denoise_preset key resolves to its catalog value', () => {
  const comp = composeTimeline(oneClip([setDenoise({ denoise_preset: 'voice' })]));
  assert.equal(comp.globalTransform.denoise, 'highpass=f=90,afftdn=nf=-25,lowpass=f=12000');
});

test('the deepfilternet preset resolves to the external-method key', () => {
  const comp = composeTimeline(oneClip([setDenoise({ denoise_preset: 'deepfilternet' })]));
  assert.equal(comp.globalTransform.denoise, 'deepfilternet', 'external method passes through as its key');
});

test("denoise_preset 'none' clears it", () => {
  const comp = composeTimeline(oneClip([setDenoise({ denoise_preset: 'none' })]));
  assert.equal(comp.globalTransform.denoise, '');
});

test('materialize emits denoise onto the EDL clip', () => {
  const comp = composeTimeline(oneClip([setDenoise({ denoise: 'afftdn=nf=-30' })]));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 1280, height: 720 });
  const seg = edl.spine.segments.find((s) => s.denoise);
  assert.ok(seg, 'a segment carries denoise into the EDL');
  assert.equal(seg.denoise, 'afftdn=nf=-30');
});

// ── detach audio ──────────────────────────────────────────────────────────────
const twoLaneView = (editDecisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'A', start: 0, end: 3, source_ref: { artifact_ref: 'a.mp4', source_id: 's1' } },
    { item_id: 's2', label: 'B', start: 0, end: 3, source_ref: { artifact_ref: 'b.mp4', source_id: 's2' } },
  ] }],
  editDecisions,
  markers: [],
});
const detach = (id) => ({ action: 'detach-audio', label: 'Detach audio', span: {}, source_ref: { source_id: id }, created_at: '2026-08-05T00:00:00.000Z', parameters: {} });

test('detach-audio silences the video clip AND spawns an audio-lane copy', () => {
  const comp = composeTimeline(twoLaneView([detach('s1')]));
  const video = comp.lanes.find((l) => l.role === 'video');
  const audio = comp.lanes.find((l) => l.laneId === 'audio-detached');
  const s1 = video.clips.find((c) => c.sourceId === 's1');
  assert.equal(s1.transform.muted, true, 's1 video clip is now silent');
  assert.ok(audio, 'a detached-audio lane exists');
  assert.equal(audio.clips.length, 1, 'one detached audio clip');
  const a = audio.clips[0];
  assert.equal(a.sourceId, 's1', 'audio clip references the same source');
  assert.equal(a.laneStart, s1.laneStart, 'audio clip sits at the same time as the video');
  assert.equal(a.laneEnd, s1.laneEnd);
});

test('detach-audio maps muted to EDL silent_audio on the video clip', () => {
  const comp = composeTimeline(twoLaneView([detach('s1')]));
  const { edl } = materializeExportEdl(comp, (ref) => (ref?.artifact_ref ?? 'x.mp4'), { width: 640, height: 360 });
  const seg = edl.spine.segments.find((s) => s.silent_audio === true);
  assert.ok(seg, 'the detached video clip renders with silent_audio');
});

test('detach-audio leaves other clips untouched', () => {
  const comp = composeTimeline(twoLaneView([detach('s1')]));
  const video = comp.lanes.find((l) => l.role === 'video');
  const s2 = video.clips.find((c) => c.sourceId === 's2');
  assert.notEqual(s2.transform.muted, true, 's2 is not silenced');
});
