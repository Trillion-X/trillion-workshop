/**
 * #156 Trails / echo (lagfun persistence): each pixel keeps max(current, decay*previous), so moving
 * bright areas leave a fading light-trail (the long-exposure / persistence-of-vision look). Distinct
 * from #motion_blur (tmix averages the last N frames uniformly); this is exponential decay that lingers.
 * A TEMPORAL-accumulation primitive the per-frame stateless grade seam cannot express.
 *
 * Proof: DATA resolution (nested {decay} + flat trails_decay; decay <= 0 dropped), materialize pass-
 * through, AND a real offline render on a one-frame flash where a LATE frame is black without trails
 * but retains decaying brightness WITH trails (L155 temporal), while the flash frame itself stays bright.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
let composeTimeline, materializeExportEdl;
let work, flash;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function meanLum(file, ss) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0; for (let i = 0; i < raw.length; i++) s += raw[i];
  return s / raw.length;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'trl-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'trl-render-'));
  flash = join(work, 'flash.mp4'); // one-frame white flash then black
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=320x240:d=2:r=24',
    '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(t,0.03)',format=rgb24", '-pix_fmt', 'yuv420p', flash]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-08T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => flash, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves trails: nested {decay} + flat trails_decay; decay <= 0 dropped', () => {
  assert.deepEqual(clipTx(view([setTx({ trails: { decay: 0.9 } })])).trails, { decay: 0.9 });
  assert.deepEqual(clipTx(view([setTx({ trails_decay: 0.85 })])).trails, { decay: 0.85 });
  assert.equal(clipTx(view([setTx({ trails: { decay: 0 } })])).trails, undefined);
  assert.equal(clipTx(view([setTx({ trails: { decay: -1 } })])).trails, undefined);
});

test('materialize emits trails (snake-cased top-level, nested decay verbatim)', () => {
  const comp = composeTimeline(view([setTx({ trails: { decay: 0.92 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].trails, { decay: 0.92 });
});

test('OFFLINE RENDER: a one-frame flash LINGERS with trails and vanishes without (L155 temporal)', () => {
  const withT = render({ trails: { decay: 0.9 } }, 'trl-on');
  const without = render({}, 'trl-off');
  // frame 0 flash: both bright.
  assert.ok(meanLum(withT, 0.0) > 150, 'flash frame is bright with trails');
  assert.ok(meanLum(without, 0.0) > 150, 'flash frame is bright without trails');
  // t=0.3 (~frame 7): without trails the frame is black; with trails it retains decaying brightness.
  const lateOff = meanLum(without, 0.3);
  const lateOn = meanLum(withT, 0.3);
  assert.ok(lateOff < 12, `no trails: the flash is gone by t=0.3: ${lateOff.toFixed(1)}`);
  assert.ok(lateOn > 40, `trails: the flash lingers at t=0.3: ${lateOn.toFixed(1)}`);
});
