/**
 * #203 Deband: remove color banding in smooth gradients (skies, shadows, fades) via ffmpeg's native `deband`
 * filter, which finds near-flat pixels whose neighbors differ by less than `threshold` and replaces them with a
 * dithered weighted average, so hard visible steps become a continuous ramp. DATA compute node
 * { compute: 'deband', params: { threshold, range } } dispatched by the generic effects stack (L090/L069): the
 * compositor never names deband; resolveEffectFragment routes `compute:'deband'` to the registry entry.
 *
 * Proof (L155): a real OFFLINE render whose oracle is a DEBAND-SPECIFIC behavioral change, on a synthetic
 * 16-band gray gradient the human eye reads as hard stripes: a central column has ~16 distinct luma values;
 * after aggressive deband the same column has MANY MORE distinct values (the steps got dithered into a
 * continuum), which is exactly what debanding does. PLUS: it visibly changes the output vs no effect, the two
 * clamped ends of `threshold` render differently (the param drives ffmpeg), and two runs are byte-identical.
 * PLUS a pure fragment/clamp unit proof (numeric-only, injection-safe).
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
let composeTimeline, materializeExportEdl, work, banded;

// A minimal compute map to unit-test the deband fragment in isolation (deband uses none of these deps, but
// createComputeEffects requires the shape).
const round3 = (n) => Math.round(n * 1000) / 1000;
const CE = createComputeEffects({ round3, W, H, safeColor: (c, d) => d, colorToRgb255: () => [0, 0, 0], fpsNum: FPS, FPS });

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
// distinct luma values down a 1px-wide central column at time `ss`.
function columnDistinct(file, ss, x) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-frames:v', '1', '-vf', `crop=1:${H}:${x}:0,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  return new Set(raw).size;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'deband-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'deband-render-'));
  // a 16-step gray vertical gradient: floor(Y/15)*16 gives 16 hard bands 0..240 down the height (visible
  // stripes). cb=cr=128 keeps it neutral gray. This is the classic banding deband is built to smooth.
  banded = join(work, 'banded.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=2:r=${FPS}`,
    '-vf', "geq=lum='floor(Y/15)*16':cb=128:cr=128", '-pix_fmt', 'yuv420p', banded]);
});

const view = () => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: [], markers: [],
});
// materialize a plain EDL then attach an ordered effects stack to the spine clip and render deterministically.
const renderWithEffects = (name, effects) => {
  const comp = composeTimeline(view());
  const { edl } = materializeExportEdl(comp, () => banded, { width: W, height: H, fps: FPS, deterministic: true });
  assert.ok(Array.isArray(edl.spine?.segments) && edl.spine.segments.length >= 1, 'materialized EDL has a spine clip');
  edl.spine.segments[0].effects = effects;
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('fragment: deband emits one filter, defaults 0.02/16, clamps threshold 0.00003..0.5 and range 1..64 (numeric-only, injection-safe)', () => {
  assert.equal(CE.deband({ threshold: 0.02, range: 16 }), 'deband=1thr=0.02000:2thr=0.02000:3thr=0.02000:4thr=0.02000:range=16:blur=1');
  assert.equal(CE.deband({}), 'deband=1thr=0.02000:2thr=0.02000:3thr=0.02000:4thr=0.02000:range=16:blur=1');
  assert.equal(CE.deband({ threshold: 9, range: 999 }), 'deband=1thr=0.50000:2thr=0.50000:3thr=0.50000:4thr=0.50000:range=64:blur=1');
  assert.equal(CE.deband({ threshold: -1, range: 0 }), 'deband=1thr=0.00003:2thr=0.00003:3thr=0.00003:4thr=0.00003:range=1:blur=1');
  // no top-level comma => keyframe-safe single filter; no free text (only digits, dots, known keys).
  assert.ok(!/,/.test(CE.deband({ threshold: 0.3, range: 20 }).replace(/^deband=/, '')), 'single filter, no comma chain');
  assert.ok(/^deband=[0-9a-z=:.]+$/.test(CE.deband({ threshold: 0.3, range: 20 })), 'injection-safe: digits/dots/colons/keys only');
});

test('OFFLINE RENDER: deband dithers the 16-band gradient into MANY more distinct values, changes output, param-driven, deterministic (L155)', () => {
  const plain = renderWithEffects('plain', []);
  const strong = renderWithEffects('strong', [{ compute: 'deband', params: { threshold: 0.5, range: 64 } }]);
  const strong2 = renderWithEffects('strong2', [{ compute: 'deband', params: { threshold: 0.5, range: 64 } }]);
  const weak = renderWithEffects('weak', [{ compute: 'deband', params: { threshold: 0.00003, range: 1 } }]);

  // deband-specific behavioral oracle: the banded column gains distinct values (steps smoothed to a ramp).
  const distinctPlain = columnDistinct(plain, 1, 160);
  const distinctStrong = columnDistinct(strong, 1, 160);
  assert.ok(distinctStrong > distinctPlain + 8,
    `deband increases distinct luma values in the banded column (plain ${distinctPlain} -> deband ${distinctStrong})`);

  // the filter actually ran (not silently dropped), and the threshold param drives ffmpeg (ends differ).
  assert.notEqual(hashFile(strong), hashFile(plain), 'deband changed the rendered output vs no effect');
  assert.notEqual(hashFile(strong), hashFile(weak), 'threshold param drives the filter (strong vs weak render differ)');
  // determinism through the emergent effects path.
  assert.equal(hashFile(strong), hashFile(strong2), 'two deband renders of the same EDL are byte-identical');
});
