/**
 * #222 Halation: the warm bloom that spreads from bright HIGHLIGHTS (the film-look staple), distinct from
 * glow/bloom (a neutral highlight bloom). DATA compute node { compute: 'halation', params: { strength } }
 * dispatched by the generic effects stack (L090/L069): extract highlights, tint warm, blur, screen-blend back,
 * so only bright areas glow warm. Forced to planar RGB so the warm mix is not a YUV purple cast.
 *
 * Proof (L155, pixel): a white box on black. AFTER halation the region JUST OUTSIDE the box (black in the
 * source) carries a WARM glow (R > G >= B and R > 0), which the no-effect render leaves black; the box center
 * stays bright; a far corner stays black (the halo is localized to highlights, not a full-frame wash). PLUS a
 * fragment/clamp unit and byte-determinism.
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
const W = 200, H = 200, FPS = 24;
let composeTimeline, materializeExportEdl, work, boxClip;

const round3 = (n) => Math.round(n * 1000) / 1000;
const CE = createComputeEffects({ round3, W, H, safeColor: (c, d) => d, colorToRgb255: () => [0, 0, 0], fpsNum: FPS, FPS });
function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
// RGB of one pixel in the first rendered frame.
function pixel(file, x, y) {
  const png = join(work, `probe-${x}-${y}-${Math.random().toString(36).slice(2)}.png`);
  ffmpeg(['-i', file, '-frames:v', '1', png]);
  const out = execFileSync('/opt/homebrew/anaconda3/bin/python3', ['-c',
    `from PIL import Image;print(*Image.open('${png}').convert('RGB').getpixel((${x},${y})))`], { encoding: 'utf8' }).trim();
  return out.split(/\s+/).map(Number);
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'hal-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'hal-render-'));
  boxClip = join(work, 'box.mp4');   // a bright white box on black
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=0.4:r=${FPS}`, '-vf', 'drawbox=x=80:y=80:w=40:h=40:color=white:t=fill', '-pix_fmt', 'yuv420p', boxClip]);
});

const view = () => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 0.4, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: [], markers: [],
});
const renderWithEffects = (name, effects) => {
  const comp = composeTimeline(view());
  const { edl } = materializeExportEdl(comp, () => boxClip, { width: W, height: H, fps: FPS, deterministic: true });
  edl.spine.segments[0].effects = effects;
  const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
  return out;
};

test('fragment: halation emits a highlight-extract + warm-tint + blur + screen graph, gbrp-wrapped, numeric-only', () => {
  const frag = CE.halation({ strength: 0.5 });
  assert.match(frag, /^format=gbrp,split=2/);
  assert.match(frag, /colorchannelmixer=rr=1:gg=0\.4:bb=0\.12/);   // warm: red kept, green/blue cut
  assert.match(frag, /blend=all_mode=screen/);
  assert.match(frag, /format=yuv420p$/);
  assert.ok(!/undefined|NaN/.test(frag), 'no undefined/NaN leaks into the filter');
  // clamp: strength out of range does not produce out-of-range sigma/opacity/threshold.
  assert.match(CE.halation({ strength: 5 }), /gblur=sigma=28/);
  assert.match(CE.halation({ strength: -5 }), /gblur=sigma=8/);
});

test('OFFLINE RENDER: halation adds a WARM glow just outside highlights; no-effect leaves it black (L155)', () => {
  const withHal = renderWithEffects('hal', [{ compute: 'halation', params: { strength: 0.9 } }]);
  const none = renderWithEffects('none', []);

  const halo = pixel(withHal, 100, 135);      // 15px below the box, black in the source
  const bare = pixel(none, 100, 135);
  const boxCenter = pixel(withHal, 100, 100);
  const farCorner = pixel(withHal, 8, 8);

  assert.ok(bare[0] < 6 && bare[1] < 6 && bare[2] < 6, `no-effect leaves the region black (${bare})`);
  assert.ok(halo[0] > bare[0] + 6, `halation brightens the region outside the box (R ${halo[0]} vs ${bare[0]})`);
  assert.ok(halo[0] >= halo[1] && halo[0] > halo[2], `the glow is WARM (R>=G>B: ${halo})`);
  assert.ok(boxCenter[0] > 180, `the highlight stays bright (${boxCenter})`);
  assert.ok(farCorner[0] < 12 && farCorner[2] < 12, `the halo is localized, not a full-frame wash (${farCorner})`);
});

test('determinism: two halation renders are byte-identical', () => {
  const a = renderWithEffects('d1', [{ compute: 'halation', params: { strength: 0.7 } }]);
  const b = renderWithEffects('d2', [{ compute: 'halation', params: { strength: 0.7 } }]);
  assert.equal(hashFile(a), hashFile(b));
});
