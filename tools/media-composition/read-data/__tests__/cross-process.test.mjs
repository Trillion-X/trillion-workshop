/**
 * #206 Cross-process LOOK preset: the iconic C-41-in-E6 lomography grade (blue/cyan SHADOWS + warm/yellow
 * HIGHLIGHTS + green midtone cast + boosted contrast/saturation) as ONE pure DATA row in LOOK_CATALOG,
 * selected by the `look` param and applied blind as a grade string (zero engine code, L090/enum-dissolution).
 *
 * Proof (L155): a real OFFLINE render on a NEUTRAL vertical grayscale gradient (top dark to bottom bright,
 * cb=cr=128 so R=G=B at every luma). The oracle is the DEFINING two-sidedness of cross-process: in the
 * SHADOW band blue rises above red (blue/cyan shadows), while in the HIGHLIGHT band red rises above blue
 * (warm/yellow highlights), so the (blue - red) bias FLIPS sign from shadows to highlights. A plain neutral
 * gradient has (blue - red) ~ 0 in both bands, so only a real cross-process grade produces the split. PLUS:
 * output differs from plain, two renders are byte-identical (deterministic), and a catalog-DATA unit assert.
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
const W = 320, H = 240, FPS = 24;
let composeTimeline, materializeExportEdl, LOOK_CATALOG, work, grad;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const digestHex = (file) => Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
// mean R,G,B (0..255) over a cropped band of the first frame at time ss.
function meanRGB(file, ss, cropExpr) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-frames:v', '1', '-vf', `${cropExpr},format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22 });
  let r = 0, g = 0, b = 0; const n = raw.length / 3;
  for (let i = 0; i < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'xproc-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline, LOOK_CATALOG } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'xproc-render-'));
  // NEUTRAL vertical grayscale gradient: top dark, bottom bright, zero chroma (cb=cr=128 => R=G=B at each row).
  // A cross-process grade must ADD a shadow-vs-highlight color split that a neutral ramp does not have.
  grad = join(work, 'grad.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=2:r=${FPS}`,
    '-vf', "geq=lum='Y/H*255':cb=128:cr=128", '-pix_fmt', 'yuv420p', grad]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions, markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-11T00:00:00.000Z', parameters: params });
const render = (name, params) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => grad, { width: W, height: H, fps: FPS, deterministic: true });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('catalog DATA: cross-process is a quote-free colorbalance+eq grade (zero engine code)', () => {
  assert.equal(LOOK_CATALOG['cross-process'], 'colorbalance=bs=.18:bh=-.18:gm=.10:rs=-.04:rh=.06,eq=contrast=1.15:saturation=1.2');
  assert.ok(!/['"]/.test(LOOK_CATALOG['cross-process']), 'grade string has no quotes (drops into the comma-joined seam)');
});

test('OFFLINE RENDER: cross-process splits blue shadows vs warm highlights, changes output, deterministic (L155)', () => {
  const plain = render('plain');
  const xp = render('xp', { look: 'cross-process' });
  const xp2 = render('xp2', { look: 'cross-process' });

  const SHADOW = `crop=${W}:40:0:8`;          // top band = dark
  const HIGH = `crop=${W}:40:0:${H - 48}`;    // bottom band = bright
  const pS = meanRGB(plain, 1, SHADOW), xS = meanRGB(xp, 1, SHADOW);
  const pH = meanRGB(plain, 1, HIGH), xH = meanRGB(xp, 1, HIGH);

  // plain neutral gradient: blue - red is ~0 in both bands.
  assert.ok(Math.abs(pS.b - pS.r) < 4 && Math.abs(pH.b - pH.r) < 4, 'neutral gradient has no color split');

  // defining behavior: cross-process pushes shadows blue (b>r) and highlights warm (r>b).
  const shadowShift = (xS.b - xS.r) - (pS.b - pS.r);
  const highShift = (xH.b - xH.r) - (pH.b - pH.r);
  assert.ok(shadowShift > 6, `shadows go blue/cyan (blue-red shift ${shadowShift.toFixed(1)})`);
  assert.ok(highShift < -6, `highlights go warm/yellow (blue-red shift ${highShift.toFixed(1)})`);
  // the two-sidedness: shadow (blue - red) bias is well above the highlight (blue - red) bias.
  assert.ok((xS.b - xS.r) > (xH.b - xH.r) + 12, 'cross-process SPLITS blue shadows from warm highlights');
  // green midtone cast present.
  assert.ok(xS.g >= xS.r || xH.g >= xH.b, 'green midtone cast present');

  assert.notEqual(digestHex(xp), digestHex(plain), 'cross-process changed the rendered output vs no look');
  assert.equal(digestHex(xp), digestHex(xp2), 'two cross-process renders of the same EDL are byte-identical');
});
