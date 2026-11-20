/**
 * #92 Overlay blend modes. A video overlay carries an opaque ffmpeg `all_mode` blend key
 * (screen/multiply/overlay/add/softlight/...) that composites it over the spine instead of a plain
 * alpha overlay, unlocking film grain / light leaks / glow / textures as DATA over the SAME
 * video-overlay primitive (L069). The blend key is opaque DATA (L090); the render passes it straight
 * to ffmpeg, so any mode works. The knob flows through the fold + materialize onto the EDL overlay;
 * the render's pixel effect (screen brightens, multiply darkens) is proven by the offline suite.
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
  const dir = tempFolder(join(tmpdir(), 'blend-'));
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

test('an add-overlay video with a blend mode carries blend on the overlay element', () => {
  const comp = composeTimeline(view([dec('add-overlay', { overlay_kind: 'video', source_ref: 'grain.mp4', blend: 'screen', start: 0, end: 2 })]));
  const o = comp.overlays.find((x) => x.overlay_kind === 'video');
  assert.ok(o);
  assert.equal(o.blend, 'screen');
});

test('blend materializes onto the EDL video_overlays row', () => {
  const comp = composeTimeline(view([dec('add-overlay', { overlay_kind: 'video', source_ref: 'grain.mp4', blend: 'multiply', start: 0, end: 2 })]));
  const { edl } = materializeExportEdl(comp, () => 'grain.mp4', { width: 640, height: 360 });
  const o = (edl.video_overlays ?? []).find((x) => x.blend);
  assert.ok(o, 'a video overlay carries the blend mode');
  assert.equal(o.blend, 'multiply');
});
