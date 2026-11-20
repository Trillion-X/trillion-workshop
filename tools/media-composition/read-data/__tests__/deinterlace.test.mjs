/**
 * #204 Deinterlace: convert interlaced footage (old cameras / broadcast, where each frame interleaves two
 * time-offset fields so horizontal motion shows as COMB teeth) to clean progressive frames via ffmpeg's native
 * `yadif`, which rebuilds each alternate line by spatial+temporal interpolation. DATA compute node
 * { compute: 'deinterlace', params: { mode } } dispatched by the generic effects stack (L090/L069).
 *
 * Proof (L155): a real OFFLINE render whose oracle is the DEFINING behavior of deinterlacing: a synthetic
 * frame with a hard 1px horizontal comb (odd rows bright, even rows dark) has enormous adjacent-row difference
 * ("comb energy"); after yadif that energy COLLAPSES because the alternate lines get interpolated toward their
 * neighbors. So sum of |row[i]-row[i+1]| down a central column drops sharply. PLUS: output changes vs no effect
 * and two runs are byte-identical. PLUS a pure fragment/clamp unit proof (numeric-only, injection-safe).
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
const W = 320, H = 240, FPS = 24;
let composeTimeline, materializeExportEdl, work, comb;

const round3 = (n) => Math.round(n * 1000) / 1000;
const CE = createComputeEffects({ round3, W, H, safeColor: (c, d) => d, colorToRgb255: () => [0, 0, 0], fpsNum: FPS, FPS });

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
// sum of absolute adjacent-row luma differences down a 1px central column ("comb energy").
function combEnergy(file, ss, x) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-frames:v', '1', '-vf', `crop=1:${H}:${x}:0,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  let e = 0;
  for (let i = 1; i < raw.length; i++) e += Math.abs(raw[i] - raw[i - 1]);
  return e;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'deint-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'deint-render-'));
  // hard 1px horizontal comb: odd rows bright (235), even rows dark (16). This is exactly the comb-tooth
  // artifact interlaced footage shows; yadif's job is to remove it by interpolating alternate lines.
  comb = join(work, 'comb.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=2:r=${FPS}`,
    '-vf', "geq=lum='if(mod(Y\\,2)\\,235\\,16)':cb=128:cr=128", '-pix_fmt', 'yuv420p', comb]);
});

const view = () => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: [], markers: [],
});
const renderWithEffects = (name, effects) => {
  const comp = composeTimeline(view());
  const { edl } = materializeExportEdl(comp, () => comb, { width: W, height: H, fps: FPS, deterministic: true });
  assert.ok(Array.isArray(edl.spine?.segments) && edl.spine.segments.length >= 1, 'materialized EDL has a spine clip');
  edl.spine.segments[0].effects = effects;
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('fragment: deinterlace emits one yadif filter, default mode 0, clamps mode 0..3 int (numeric-only, injection-safe)', () => {
  assert.equal(CE.deinterlace({}), 'yadif=mode=0:parity=-1:deint=0');
  assert.equal(CE.deinterlace({ mode: 1 }), 'yadif=mode=1:parity=-1:deint=0');
  assert.equal(CE.deinterlace({ mode: 9 }), 'yadif=mode=3:parity=-1:deint=0');
  assert.equal(CE.deinterlace({ mode: -5 }), 'yadif=mode=0:parity=-1:deint=0');
  assert.ok(/^yadif=[0-9a-z=:.-]+$/.test(CE.deinterlace({ mode: 2 })), 'injection-safe: only known keys/digits');
});

test('OFFLINE RENDER: yadif collapses the 1px comb energy, changes output, deterministic (L155)', () => {
  const plain = renderWithEffects('plain', []);
  const deint = renderWithEffects('deint', [{ compute: 'deinterlace', params: { mode: 0 } }]);
  const deint2 = renderWithEffects('deint2', [{ compute: 'deinterlace', params: { mode: 0 } }]);

  const combPlain = combEnergy(plain, 1, 160);
  const combDeint = combEnergy(deint, 1, 160);
  // the defining behavior: deinterlacing removes the comb, so adjacent-row difference collapses.
  assert.ok(combDeint < combPlain * 0.6,
    `yadif collapses comb energy (plain ${combPlain} -> deinterlaced ${combDeint})`);

  assert.notEqual(hashFile(deint), hashFile(plain), 'deinterlace changed the rendered output vs no effect');
  assert.equal(hashFile(deint), hashFile(deint2), 'two deinterlace renders of the same EDL are byte-identical');
});
