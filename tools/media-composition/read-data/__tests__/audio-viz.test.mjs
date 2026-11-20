/**
 * #96 Audio-reactive visualizer overlay. A new overlay_kind 'audioviz' whose VIDEO is GENERATED from
 * the program audio (waveform / spectrum / cqt / bars, the podcast/music-video look). L069: `viz` is a
 * DATA-selected producer key over the SAME overlay compositing path; the render generates the
 * visualizer from the audio and keys it over the frame. The overlay flows through the fold +
 * materialize onto edl.audio_viz_overlays; the render's frame-by-frame reactivity is proven offline.
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
  const dir = tempFolder(join(tmpdir(), 'aviz-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const view = (params) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: [{ action: 'add-overlay', label: 'add-overlay', span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters: params }],
  markers: [],
});

test('an add-overlay with a viz key becomes an audioviz overlay', () => {
  const comp = composeTimeline(view({ overlay_kind: 'audioviz', viz: 'waveform', height: 0.2 }));
  const o = comp.overlays.find((x) => x.overlay_kind === 'audioviz');
  assert.ok(o);
  assert.equal(o.viz, 'waveform');
});

test('the viz key alone infers the audioviz kind', () => {
  const comp = composeTimeline(view({ viz: 'spectrum' }));
  const o = comp.overlays.find((x) => x.overlay_kind === 'audioviz');
  assert.ok(o, 'viz alone infers audioviz');
  assert.equal(o.viz, 'spectrum');
});

test('audioviz overlays materialize onto edl.audio_viz_overlays', () => {
  const comp = composeTimeline(view({ overlay_kind: 'audioviz', viz: 'bars', x: 0, y: 0.8, width: 1, height: 0.2, color: 'cyan' }));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  const o = (edl.audio_viz_overlays ?? []).find((x) => x.viz);
  assert.ok(o, 'an audio-viz overlay materializes');
  assert.equal(o.viz, 'bars');
  assert.equal(o.color, 'cyan');
});
