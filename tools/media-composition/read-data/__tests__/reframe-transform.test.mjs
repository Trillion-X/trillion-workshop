/**
 * #70 Auto-reframe: (1) a set-transform decision carrying nested `reframe` is extracted onto
 * the committed globalTransform via composeTimeline; (2) the materialize rename-bridge emits a
 * clip's `reframe` (aspect + follow track) onto the EDL clip row, which video-compose compiles
 * to an animated subject-follow crop. The full DATA -> mp4 path is proven by the offline render.
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
  const ctOut = join(dir, 'ct.mjs');
  const meOut = join(dir, 'me.mjs');
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ctOut}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${meOut}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ctOut));
  ({ materializeExportEdl } = await import(meOut));
});

test('nested reframe in a set-transform decision is extracted onto globalTransform', () => {
  const view = {
    lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4 }] }],
    editDecisions: [{
      action: 'set-transform', label: 'set-transform', span: {}, source_ref: { item_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z',
      parameters: { transform: { reframe: { aspect_w: 9, aspect_h: 16, track: [{ t: 0, cx: 0.15 }, { t: 4, cx: 0.85 }] } } },
    }],
    markers: [],
  };
  const comp = composeTimeline(view);
  const rf = comp.globalTransform?.reframe;
  assert.ok(rf, 'reframe present on the committed globalTransform');
  assert.equal(rf.aspect_w, 9);
  assert.equal(rf.aspect_h, 16);
  assert.equal(rf.track.length, 2, 'follow track carried through extraction');
  assert.equal(rf.track[1].cx, 0.85);
});

test('materialize rename-bridge emits reframe on the EDL clip row', () => {
  // A composition with one clip carrying reframe on its transform (camelCase author side).
  const comp = {
    lanes: [{ laneId: 'video', role: 'video', label: 'Video', tone: 'video', duration: 4, clips: [
      { clipId: 'c1', sourceId: 's1', inPoint: 0, outPoint: 4, laneStart: 0, laneEnd: 4,
        transform: { reframe: { aspect_w: 9, aspect_h: 16, track: [{ t: 0, cx: 0.2 }, { t: 4, cx: 0.8 }] } } },
    ] }],
    durationSeconds: 4, markers: [], globalTransform: {},
  };
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 1080, height: 1920 });
  const seg = edl.spine.segments.find((s) => s.reframe);
  assert.ok(seg, 'a segment carries reframe into the EDL');
  assert.equal(seg.reframe.aspect_w, 9);
  assert.equal(seg.reframe.aspect_h, 16);
  assert.equal(seg.reframe.track[1].cx, 0.8, 'follow track survives the rename bridge');
});
