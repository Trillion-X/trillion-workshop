/**
 * #86 Privacy blur / mosaic region: censor a rectangle of the frame itself over a window.
 * A new overlay_kind 'region' (rect + mode blur|mosaic + strength) folds into overlays and
 * materialize emits edl.region_overlays; video-compose crops the rect, blurs/pixelizes it, and
 * overlays it back gated by enable=between. The actual censoring is proven by the offline render.
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
  const dir = tempFolder(join(tmpdir(), 'region-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

const clip = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: decisions, markers: [],
});
const addRegion = (params) => ({ action: 'add-overlay', label: 'Censor', span: {}, source_ref: {}, created_at: '2026-08-05T00:00:00.000Z', parameters: { overlay_kind: 'region', ...params } });

test('add-overlay with a region_mode resolves a region overlay', () => {
  const comp = composeTimeline(clip([addRegion({ region_mode: 'blur', x: 0.33, y: 0.33, width: 0.34, height: 0.34, region_strength: 15, start: 0, end: 3 })]));
  const regions = comp.overlays.filter((o) => o.overlay_kind === 'region');
  assert.equal(regions.length, 1);
  assert.equal(regions[0].region_mode, 'blur');
  assert.equal(regions[0].width, 0.34);
  assert.equal(regions[0].region_strength, 15);
});

test('overlay_kind region is inferred from region_mode when overlay_kind is omitted', () => {
  const comp = composeTimeline(clip([{ action: 'add-overlay', label: 'r', span: {}, source_ref: {}, created_at: '2026-08-05T00:00:00.000Z', parameters: { region_mode: 'mosaic', x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }]));
  const regions = comp.overlays.filter((o) => o.overlay_kind === 'region');
  assert.equal(regions.length, 1);
  assert.equal(regions[0].region_mode, 'mosaic');
});

test('materialize emits region overlays as edl.region_overlays with mode + rect', () => {
  const comp = composeTimeline(clip([addRegion({ region_mode: 'blur', x: 0.25, y: 0.25, width: 0.5, height: 0.5, region_strength: 20, start: 1, end: 2 })]));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  assert.ok(Array.isArray(edl.region_overlays) && edl.region_overlays.length === 1);
  const r = edl.region_overlays[0];
  assert.equal(r.mode, 'blur');
  assert.equal(r.width, 0.5);
  assert.equal(r.strength, 20);
  assert.equal(r.start, 1);
});
