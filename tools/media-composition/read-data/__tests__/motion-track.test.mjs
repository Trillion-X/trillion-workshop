/**
 * #101 Motion tracking. Proves the pure core + the DATA carry: (1) centroidFromLumaGrid finds the
 * bright subject's normalized center in a synthetic frame, (2) trackFromFrameGrids builds a moving
 * path, and (3) an add-overlay decision carrying a `track` folds through composeTimeline and
 * materializes onto the EDL overlay as `track` (which video-compose binds x/y to, follow-proven live).
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline, materializeExportEdl, centroidFromLumaGrid, trackFromFrameGrids;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'trk-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs'); const tb = join(dir, 'tb.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', '..', 'do-work', 'detect-track-browser.ts'), `--outfile=${tb}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
  ({ centroidFromLumaGrid, trackFromFrameGrids } = await import(tb));
});

// a 4x4 luma grid with one bright cell -> the centroid is that cell's normalized center.
const gridWithBrightAt = (col, row, w = 4, h = 4) => {
  const g = new Array(w * h).fill(0);
  g[row * w + col] = 255;
  return g;
};

test('centroidFromLumaGrid finds the bright subject center', () => {
  const c = centroidFromLumaGrid(gridWithBrightAt(0, 1), 4, 4, { threshold: 100 });
  // col 0 center = (0+0.5)/4 = 0.125 ; row 1 center = (1+0.5)/4 = 0.375
  assert.ok(Math.abs(c.x - 0.125) < 1e-3, `x ~0.125, got ${c.x}`);
  assert.ok(Math.abs(c.y - 0.375) < 1e-3, `y ~0.375, got ${c.y}`);
});

test('an all-dark frame falls back to center', () => {
  const c = centroidFromLumaGrid(new Array(16).fill(0), 4, 4, { threshold: 100 });
  assert.deepEqual(c, { x: 0.5, y: 0.5 });
});

test('trackFromFrameGrids builds a moving path (left to right)', () => {
  const grids = [gridWithBrightAt(0, 1), gridWithBrightAt(3, 1)];
  const path = trackFromFrameGrids(grids, 4, 4, 2, { threshold: 100 });
  assert.equal(path.length, 2);
  assert.ok(path[0].x < path[1].x, 'the subject moved right');
  assert.equal(path[0].t, 0);
  assert.equal(path[1].t, 0.5);
});

test('an add-overlay track folds and materializes onto the EDL overlay', () => {
  const track = [{ t: 0, x: 0.1, y: 0.5 }, { t: 4, x: 0.9, y: 0.5 }];
  const view = {
    lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
      { item_id: 'v1', label: 'Clip', start: 0, end: 4, source_ref: { artifact_ref: 'v.mp4', source_id: 'v1' } },
    ] }],
    editDecisions: [{ action: 'add-overlay', source_ref: {}, parameters: { overlay_kind: 'image', image_path: 'm.png', width: 16, start: 0, end: 4, track }, created_at: 'x' }],
    markers: [],
  };
  const comp = composeTimeline(view);
  const { edl } = materializeExportEdl(comp, () => 'v.mp4', {});
  assert.ok(Array.isArray(edl.image_overlays) && edl.image_overlays.length === 1, 'one image overlay');
  const t = edl.image_overlays[0].track;
  assert.ok(Array.isArray(t) && t.length === 2, 'the track carried through to the EDL');
  assert.deepEqual(t[0], { t: 0, x: 0.1, y: 0.5 });
});
