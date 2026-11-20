/**
 * #172 Gradient map: map a clip's normalized LUMA to a MULTI-STOP color ramp (the CapCut / Premiere-Lumetri /
 * DaVinci "gradient map" tonal grade). DATA gradientMap: true | { stops: [{ at: 0..1, color: "name|#hex" }, ... ] }
 * (>= 2 stops). Each output channel is the piecewise-linear blend of the two surrounding stop colors at the
 * pixel's luma, held flat below the first stop and above the last. The N-stop generalization of #127 duotone
 * (which is exactly two stops: shadow + highlight). Colors resolve via colorToRgb255 (injection-safe).
 *
 * Proof: DATA resolution (bare `true` seeds the default 3-stop ramp; nested {stops} custom; stops sorted by
 * `at`; `at` clamps 0..1; invalid color dropped; < 2 valid stops => whole field dropped), materialize
 * pass-through, AND a real OFFLINE render on a static black->white luma gradient where the DARK end becomes
 * blue-dominant (default stop0 #0a2540, B >> R) and the BRIGHT end becomes warm/amber (last stop #ffb454,
 * R >> B), while the unfiltered gradient is neutral at both ends (a base-vs-filtered + within-frame proof
 * that the luma->ramp mapping actually happened, not a pass-through or a uniform tint). L155.
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

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
let composeTimeline, materializeExportEdl;
let work, grad;
const W = 320;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// [r,g,b] at (x,y) averaged over a small column band so a single-pixel x264 wobble cannot flip the sign.
function px(raw, x, y) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -2; dy <= 2; dy++) {
    const i = ((y + dy) * W + x) * 3;
    if (i >= 0 && i + 2 < raw.length) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; n++; }
  }
  return [r / n, g / n, b / n];
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'gm-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'gm-render-'));
  grad = join(work, 'grad.mp4'); // static horizontal black->white luma gradient (left dark, right bright)
  // An EXACT ramp, the source convention the rest of this suite folder already uses. `gradients`
  // is a RANDOM-gradient generator and draws a different pattern per run, so a pixel assertion
  // against it passes or fails on the draw. Its sibling `posterize` was red in the corpus for
  // that reason while this one happened to keep drawing a usable gradient.
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=2:r=24',
    '-vf', "geq=lum='X*255/W':cb=128:cr=128", '-pix_fmt', 'yuv420p', grad]);
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
  const { edl } = materializeExportEdl(comp, () => grad, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves gradientMap: bare `true` seeds the default 3-stop ramp; nested {stops} custom; sorted by `at`', () => {
  const def = clipTx(view([setTx({ gradientMap: true })])).gradientMap;
  assert.equal(def.stops.length, 3);
  assert.deepEqual(def.stops.map((s) => s.at), [0, 0.5, 1]);
  assert.equal(def.stops[0].color, '#0a2540');

  const custom = clipTx(view([setTx({ gradientMap: { stops: [{ at: 1, color: 'white' }, { at: 0, color: 'black' }] } })])).gradientMap;
  assert.deepEqual(custom.stops, [{ at: 0, color: 'black' }, { at: 1, color: 'white' }]); // sorted by at
});

test('resolves gradientMap: `at` clamps 0..1; invalid color dropped; < 2 valid stops => field dropped', () => {
  const clamped = clipTx(view([setTx({ gradientMap: { stops: [{ at: -3, color: '#000000' }, { at: 9, color: '#ffffff' }] } })])).gradientMap;
  assert.deepEqual(clamped.stops.map((s) => s.at), [0, 1]);
  // one valid + one garbage-color stop => only 1 survives => whole field dropped
  assert.equal(clipTx(view([setTx({ gradientMap: { stops: [{ at: 0, color: 'teal' }, { at: 1, color: 'not a color!!' }] } })])).gradientMap, undefined);
  // bare true with no default would be caught; here just confirm empty stops array drops it
  assert.equal(clipTx(view([setTx({ gradientMap: { stops: [] } })])).gradientMap, undefined);
});

test('materialize emits gradient_map (camelCase field snake-cased on the EDL, stops verbatim)', () => {
  const comp = composeTimeline(view([setTx({ gradientMap: { stops: [{ at: 0, color: 'black' }, { at: 1, color: 'white' }] } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].gradient_map, { stops: [{ at: 0, color: 'black' }, { at: 1, color: 'white' }] });
});

test('OFFLINE RENDER: default ramp maps dark luma -> blue stop and bright luma -> amber stop (L155)', () => {
  const mapped = render({ gradientMap: true }, 'gm');
  const plain = render({}, 'gm-off');
  const mr = frame(mapped, 0.0);
  const pr = frame(plain, 0.0);
  const y = 120, xDark = 20, xBright = 300;

  const [mdR, , mdB] = px(mr, xDark, y);   // mapped dark end  => default stop0 #0a2540 (B=64 >> R=10), blue
  const [pdR, , pdB] = px(pr, xDark, y);   // plain dark end   => near-black, neutral
  const [mbR, , mbB] = px(mr, xBright, y); // mapped bright end => last stop #ffb454 (R=255 >> B=84), amber
  const [pbR, , pbB] = px(pr, xBright, y); // plain bright end  => near-white, neutral

  assert.ok(mdB - mdR > 25, `mapped dark end is blue-dominant (B-R): ${(mdB - mdR).toFixed(1)}`);
  assert.ok(Math.abs(pdB - pdR) < 15, `plain dark end is neutral (|B-R|): ${Math.abs(pdB - pdR).toFixed(1)}`);
  assert.ok(mbR - mbB > 60, `mapped bright end is warm/amber (R-B): ${(mbR - mbB).toFixed(1)}`);
  assert.ok(Math.abs(pbR - pbB) < 15, `plain bright end is neutral (|R-B|): ${Math.abs(pbR - pbB).toFixed(1)}`);
});

test('OFFLINE RENDER: deterministic mode renders the gradient map BYTE-IDENTICAL (L155, #170 flake-hardening)', () => {
  // #172 is the same "map luma to color via geq" family as #127 duotone, whose render test the ledger
  // flags as ~25% flaky under thread nondeterminism. Prove #172 is reproducible under #170 deterministic
  // mode so it never joins that flake class: the SAME EDL rendered twice with encode.deterministic is
  // byte-identical (sha256), and the identity is of REAL content (the dark end is still the blue stop),
  // not of an empty frame.
  const detRender = (name) => {
    const comp = composeTimeline(view([setTx({ gradientMap: true })]));
    const { edl } = materializeExportEdl(comp, () => grad, { width: 320, height: 240, fps: 24, deterministic: true });
    const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
    writeFileSync(edlFile, JSON.stringify(edl));
    execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
    return out;
  };
  const a = detRender('gm-det-a');
  const b = detRender('gm-det-b');
  const ha = '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(a)))).toString('hex');
  const hb = '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(b)))).toString('hex');
  assert.equal(ha, hb, 'two deterministic gradient-map renders are byte-identical');
  const [dR, , dB] = px(frame(a, 0.0), 20, 120); // identity is of the real ramp, not an empty frame
  assert.ok(dB - dR > 25, `deterministic render still shows the ramp (dark end blue, B-R): ${(dB - dR).toFixed(1)}`);
});
