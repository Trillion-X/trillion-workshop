/**
 * #79 Picture-in-picture: a video overlay placed by a CORNER preset (non-coder affordance).
 * The render primitive (edl.video_overlays with x/y/scale) already exists from #78, so #79 is
 * pure DATA: `pip_corner` resolves to ffmpeg x/y exprs via PIP_CORNER_CATALOG and gives a video
 * a default inset scale, while an explicit x/y still wins. Proven end-to-end by the offline render.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline, materializeExportEdl, PIP_CORNER_CATALOG;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'pip-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline, PIP_CORNER_CATALOG } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const clip = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: decisions, markers: [],
});
const addPip = (params) => ({ action: 'add-overlay', label: 'PiP', span: {}, source_ref: {}, created_at: '2026-08-05T00:00:00.000Z', parameters: { overlay_kind: 'video', source_ref: '1f:pip', ...params } });

test('PIP_CORNER_CATALOG covers the four corners + center', () => {
  for (const c of ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']) {
    assert.ok(PIP_CORNER_CATALOG[c] && PIP_CORNER_CATALOG[c].x && PIP_CORNER_CATALOG[c].y, `${c} present`);
  }
});

test('a pip_corner resolves to its catalog x/y and a default inset scale', () => {
  const comp = composeTimeline(clip([addPip({ pip_corner: 'bottom-right', start: 0, end: 3 })]));
  const v = comp.overlays.find((o) => o.overlay_kind === 'video');
  assert.equal(v.x, 'W-w-24');
  assert.equal(v.y, 'H-h-24');
  assert.equal(v.scale, 0.3, 'video PiP gets a default inset scale');
});

test('an explicit x/y overrides the corner preset', () => {
  const comp = composeTimeline(clip([addPip({ pip_corner: 'center', x: 100, y: 50 })]));
  const v = comp.overlays.find((o) => o.overlay_kind === 'video');
  assert.equal(v.x, 100);
  assert.equal(v.y, 50);
});

test('an explicit scale overrides the default inset', () => {
  const comp = composeTimeline(clip([addPip({ pip_corner: 'top-left', scale: 0.5 })]));
  const v = comp.overlays.find((o) => o.overlay_kind === 'video');
  assert.equal(v.scale, 0.5);
  assert.equal(v.x, '24');
});

test('materialize forwards the resolved PiP position + scale to edl.video_overlays', () => {
  const comp = composeTimeline(clip([addPip({ pip_corner: 'top-right', start: 1, end: 2 })]));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  assert.equal(edl.video_overlays.length, 1);
  assert.equal(edl.video_overlays[0].x, 'W-w-24');
  assert.equal(edl.video_overlays[0].scale, 0.3);
});
