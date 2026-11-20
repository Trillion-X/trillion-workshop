/**
 * #78 Chroma key / green-screen + the video-overlay primitive it composites through.
 *  - chroma_key: a set-transform `chroma_key` (opaque colorkey string) OR a `chroma_key_color`
 *    preset resolves onto the clip transform, and materialize forwards it to the EDL clip.
 *  - video overlay: an add-overlay with overlay_kind 'video' (source_ref + optional chroma_key)
 *    resolves into overlays and materialize emits edl.video_overlays, the PiP / green-screen
 *    composite path. The actual background reveal is proven by the offline render.
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
  const dir = tempFolder(join(tmpdir(), 'chroma-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const clip = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (t) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters: { transform: t } });

test('an explicit chroma_key string resolves onto the transform', () => {
  const comp = composeTimeline(clip([setTx({ chroma_key: 'colorkey=0x00ff00:0.3:0.1' })]));
  assert.equal(comp.globalTransform.chroma_key, 'colorkey=0x00ff00:0.3:0.1');
});

test('a chroma_key_color preset resolves to its catalog colorkey', () => {
  const comp = composeTimeline(clip([setTx({ chroma_key_color: 'green' })]));
  assert.equal(comp.globalTransform.chroma_key, 'colorkey=0x00ff00:0.30:0.10');
});

test("chroma_key_color 'none' clears it", () => {
  const comp = composeTimeline(clip([setTx({ chroma_key_color: 'none' })]));
  assert.equal(comp.globalTransform.chroma_key, '');
});

test('materialize forwards chroma_key onto the EDL clip', () => {
  const comp = composeTimeline(clip([setTx({ chroma_key: 'colorkey=0x0000ff:0.2:0.1' })]));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  const seg = edl.spine.segments.find((s) => s.chroma_key);
  assert.ok(seg, 'a segment carries chroma_key into the EDL');
  assert.equal(seg.chroma_key, 'colorkey=0x0000ff:0.2:0.1');
});

// ── video overlay (PiP / green-screen composite) ──────────────────────────────
const addVideoOverlay = (params) => ({ action: 'add-overlay', label: 'Video overlay', span: {}, source_ref: {}, created_at: '2026-08-05T00:00:00.000Z', parameters: { overlay_kind: 'video', ...params } });

test('add-overlay with overlay_kind video resolves a video overlay with chroma_key', () => {
  const comp = composeTimeline(clip([addVideoOverlay({ source_ref: '1f:abc', chroma_key: 'colorkey=0x00ff00:0.3:0.1', x: 20, y: 20, scale: 0.4, start: 0, end: 3 })]));
  const vids = comp.overlays.filter((o) => o.overlay_kind === 'video');
  assert.equal(vids.length, 1);
  assert.equal(vids[0].source_ref, '1f:abc');
  assert.equal(vids[0].chroma_key, 'colorkey=0x00ff00:0.3:0.1');
  assert.equal(vids[0].scale, 0.4);
  assert.equal(vids[0].x, 20);
});

test('overlay_kind is inferred from source_ref when omitted', () => {
  const comp = composeTimeline(clip([{ action: 'add-overlay', label: 'v', span: {}, source_ref: {}, created_at: '2026-08-05T00:00:00.000Z', parameters: { source_path: '/tmp/pip.mp4', x: 0, y: 0 } }]));
  const vids = comp.overlays.filter((o) => o.overlay_kind === 'video');
  assert.equal(vids.length, 1, 'source_path implies a video overlay');
  assert.equal(vids[0].source_path, '/tmp/pip.mp4');
});

test('materialize emits video overlays as edl.video_overlays', () => {
  const comp = composeTimeline(clip([addVideoOverlay({ source_ref: '1f:def', chroma_key: 'colorkey=0x00ff00:0.3:0.1', start: 1, end: 2 })]));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  assert.ok(Array.isArray(edl.video_overlays) && edl.video_overlays.length === 1, 'one video overlay in the EDL');
  assert.equal(edl.video_overlays[0].source_ref, '1f:def');
  assert.equal(edl.video_overlays[0].chroma_key, 'colorkey=0x00ff00:0.3:0.1');
  assert.equal(edl.video_overlays[0].start, 1);
});
