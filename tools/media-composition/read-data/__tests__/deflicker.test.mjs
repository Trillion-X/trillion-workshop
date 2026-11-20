/**
 * #213 Deflicker: remove temporal brightness FLICKER (timelapse / LED / old-film pulsing) by evening each
 * frame's luminance against a rolling window of `size` neighbouring frames (native ffmpeg `deflicker`). DATA
 * compute node { compute: 'deflicker', params: { size } } dispatched by the generic effects stack (L090/L069).
 * The TEMPORAL twin of the spatial band/contrast fixers: it fixes variation ACROSS frames, not within one.
 *
 * Proof (L155, temporal): a clip whose whole-frame brightness HARD-FLICKERS (frame N even = bright 228, odd =
 * dark 28). The oracle is the DEFINING behavior: the standard deviation of per-frame mean brightness ACROSS
 * frames COLLAPSES after deflicker (the rolling average cancels the oscillation), while a no-effect render keeps
 * the full swing. PLUS output changes vs no effect, two runs are byte-identical, and a fragment/clamp unit.
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
import { createComputeEffects } from '../../do-work/effect-registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
const W = 160, H = 120, FPS = 24;
let composeTimeline, materializeExportEdl, work, flicker;

const round3 = (n) => Math.round(n * 1000) / 1000;
const CE = createComputeEffects({ round3, W, H, safeColor: (c, d) => d, colorToRgb255: () => [0, 0, 0], fpsNum: FPS, FPS });

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
// mean luma of each decoded frame (whole-frame gray average), as an array.
function frameMeans(file) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 27 });
  const per = W * H, means = [];
  for (let f = 0; (f + 1) * per <= raw.length; f++) {
    let s = 0; const base = f * per;
    for (let i = 0; i < per; i++) s += raw[base + i];
    means.push(s / per);
  }
  return means;
}
const stddev = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'dfl-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'dfl-render-'));
  // whole-frame brightness HARD-FLICKERS per frame: N even => 228, N odd => 28 (uniform per frame).
  flicker = join(work, 'flicker.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=0.6:r=${FPS}`,
    '-vf', "geq=lum='128+100*(2*mod(N\\,2)-1)':cb=128:cr=128", '-pix_fmt', 'yuv420p', flicker]);
});

const view = () => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 0.6, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: [], markers: [],
});
const renderWithEffects = (name, effects) => {
  const comp = composeTimeline(view());
  const { edl } = materializeExportEdl(comp, () => flicker, { width: W, height: H, fps: FPS, deterministic: true });
  edl.spine.segments[0].effects = effects;
  const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
  return out;
};

test('fragment: deflicker emits one deflicker filter, default size 5, clamps size 2..129 int (numeric-only, injection-safe)', () => {
  assert.equal(CE.deflicker({}), 'deflicker=size=5:mode=am');
  assert.equal(CE.deflicker({ size: 10 }), 'deflicker=size=10:mode=am');
  assert.equal(CE.deflicker({ size: 999 }), 'deflicker=size=129:mode=am');
  assert.equal(CE.deflicker({ size: 1 }), 'deflicker=size=2:mode=am');
  assert.ok(/^deflicker=[0-9a-z=:]+$/.test(CE.deflicker({ size: 7 })), 'injection-safe: only known keys/digits');
});

test('OFFLINE RENDER: deflicker collapses the across-frame brightness swing, changes output, deterministic (L155)', () => {
  const plain = renderWithEffects('plain', []);
  const deflick = renderWithEffects('deflick', [{ compute: 'deflicker', params: { size: 5 } }]);
  const deflick2 = renderWithEffects('deflick2', [{ compute: 'deflicker', params: { size: 5 } }]);

  const sdPlain = stddev(frameMeans(plain).slice(2));   // drop the first frames (deflicker warm-up window)
  const sdDeflick = stddev(frameMeans(deflick).slice(2));
  // the defining behavior: the frame-to-frame brightness variation collapses.
  assert.ok(sdPlain > 60, `flicker source really swings frame-to-frame (stddev ${sdPlain.toFixed(1)})`);
  assert.ok(sdDeflick < sdPlain * 0.5, `deflicker evens the brightness (stddev plain ${sdPlain.toFixed(1)} -> deflickered ${sdDeflick.toFixed(1)})`);

  assert.notEqual(hashFile(deflick), hashFile(plain), 'deflicker changed the rendered output vs no effect');
  assert.equal(hashFile(deflick), hashFile(deflick2), 'two deflicker renders of the same EDL are byte-identical');
});
