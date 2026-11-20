/**
 * #212 Auto-crop (black-bar / letterbox removal): `do-work/detect-crop.mjs` runs ffmpeg `cropdetect` to find the
 * content rectangle inside black borders and emits it as `{width,height,x,y}`. The caller sets it as the clip's
 * `crop`, which video-compose applies as absolute-px `crop=w:h:x:y` (existing seam, zero new render code, L069).
 *
 * Proof (L155): a clip that is a red band on a BLACK background (top+bottom letterbox bars). Layers:
 *  (1) PURE unit: parseCropDetect extracts the last crop=w:h:x:y; detectCrop returns the content rect and a
 *      full-frame source is a null no-op.
 *  (2) OFFLINE RENDER: apply the detected crop and the black bars are GONE - the rendered frame's top and
 *      bottom rows become content (red) instead of black - while the uncropped render still has black bars.
 *      Plus byte-determinism.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { blake3 } from '@noble/hashes/blake3.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCropDetect, detectCrop } from '../../do-work/detect-crop.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
const W = 320, H = 240, FPS = 24;
let composeTimeline, materializeExportEdl, work, barred;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
// mean R over a horizontal band (rows [y0, y0+h)) of the rendered first frame.
function bandMeanR(file, y0, h) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', `crop=${W}:${h}:0:${y0},format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22 });
  let r = 0; const n = raw.length / 3;
  for (let i = 0; i < raw.length; i += 3) r += raw[i];
  return r / n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'crop-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'crop-render-'));
  // letterboxed: red content band [y 60..180] on a black frame (top+bottom black bars).
  barred = join(work, 'barred.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=1:r=${FPS}`,
    '-vf', 'drawbox=x=0:y=60:w=320:h=120:color=red:t=fill', '-pix_fmt', 'yuv420p', barred]);
});

const view = () => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: [], markers: [],
});
const render = (name, crop) => {
  const comp = composeTimeline(view());
  const { edl } = materializeExportEdl(comp, () => barred, { width: W, height: H, fps: FPS, deterministic: true });
  if (crop) edl.spine.segments[0].crop = crop; // caller sets the detected rect; video-compose applies crop=w:h:x:y
  const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
  return out;
};

test('PURE unit: parseCropDetect takes the settled rect; detectCrop returns content rect + full-frame is a no-op', () => {
  assert.deepEqual(parseCropDetect('x\ncrop=100:50:0:5\ncrop=320:120:0:60\n'), { w: 320, h: 120, x: 0, y: 60 });
  assert.equal(parseCropDetect('no crop here'), null);
  const d = detectCrop(barred, { limit: 24, round: 2 });
  assert.ok(d.crop && d.crop.h < d.source.height, `detected a content rect shorter than source (${JSON.stringify(d.crop)} of ${JSON.stringify(d.source)})`);
  assert.ok(d.crop.y >= 40 && d.crop.y <= 80 && d.crop.h >= 100 && d.crop.h <= 140, 'rect is ~the red band [y60 h120]');
});

test('OFFLINE RENDER: applying the detected crop removes the black bars (top/bottom become content), deterministic (L155)', () => {
  const { crop } = detectCrop(barred, { limit: 24, round: 2 });

  const uncropped = render('uncropped', null);
  const cropped = render('cropped', crop);
  const cropped2 = render('cropped2', crop);

  // uncropped: top + bottom bands are BLACK bars (low R). cropped: after crop+scale-norm the content fills the
  // frame so the top + bottom bands are now RED content (high R).
  const upTop = bandMeanR(uncropped, 4, 20), upBot = bandMeanR(uncropped, H - 24, 20);
  const cpTop = bandMeanR(cropped, 4, 20), cpBot = bandMeanR(cropped, H - 24, 20);
  assert.ok(upTop < 40 && upBot < 40, `uncropped has black bars top/bottom (R top ${upTop.toFixed(0)}, bot ${upBot.toFixed(0)})`);
  assert.ok(cpTop > 120 && cpBot > 120, `auto-crop removed the bars: top/bottom are now content (R top ${cpTop.toFixed(0)}, bot ${cpBot.toFixed(0)})`);

  assert.equal(hashFile(cropped), hashFile(cropped2), 'two auto-cropped renders are byte-identical');
});
