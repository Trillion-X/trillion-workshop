/**
 * #207 golden-hour LOOK_STACK: the warm sunset look as a named multi-effect DATA preset (LOOK_STACKS in
 * effect-registry.mjs). A composition NO single grade string can express: a warm white-balance grade + a
 * highlight BLOOM (glow's split/blend) + a gentle vignette. Selected by the `look_stack` param, resolved at
 * render time by resolveLookStack and prepended to the clip's effect stack (L069 emergence / L090, zero code).
 *
 * Proof (L155): a real OFFLINE render on a NEUTRAL mid-gray frame with a bright white center square (so the
 * bloom has highlights and warmth/vignette are measurable). Two-part oracle for the DEFINING behavior:
 *   (1) WARMTH: whole-frame mean(red) rises above mean(blue) (a neutral frame has red ~ blue).
 *   (2) VIGNETTE: a corner region gets DARKER than the same corner without the look.
 * PLUS: output differs from plain, two renders are byte-identical (deterministic), and the look_stack
 * resolves to the expected ordered node array (catalog-DATA unit, zero engine code).
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
import { resolveLookStack } from '../../do-work/effect-registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
const W = 320, H = 240, FPS = 24;
let composeTimeline, materializeExportEdl, work, src;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function meanRGB(file, ss, cropExpr) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-frames:v', '1', '-vf', `${cropExpr},format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22 });
  let r = 0, g = 0, b = 0; const n = raw.length / 3;
  for (let i = 0; i < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}
const luma = ({ r, g, b }) => 0.299 * r + 0.587 * g + 0.114 * b;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'golden-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'golden-render-'));
  // NEUTRAL mid-gray frame with a bright white center square: gray => red==blue (warmth measurable),
  // white square => highlights for the bloom, corners stay gray (vignette darkening measurable).
  src = join(work, 'src.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=0x808080:s=${W}x${H}:d=2:r=${FPS}`,
    '-vf', 'drawbox=x=120:y=80:w=80:h=80:color=white:t=fill', '-pix_fmt', 'yuv420p', src]);
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
  const { edl } = materializeExportEdl(comp, () => src, { width: W, height: H, fps: FPS, deterministic: true });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('catalog DATA: golden-hour resolves to an ordered warm-grade + glow + vignette stack (zero engine code)', () => {
  const stack = resolveLookStack('golden-hour');
  assert.ok(Array.isArray(stack) && stack.length === 3, 'golden-hour is a 3-node LOOK_STACK');
  assert.ok(/colorbalance=rs=\.16/.test(stack[0].template), 'node 1 is the warm grade');
  assert.equal(stack[1].compute, 'glow', 'node 2 is the highlight bloom');
  assert.equal(stack[2].template, 'vignette=PI/5', 'node 3 is the vignette');
});

test('OFFLINE RENDER: golden-hour warms the frame and darkens corners, changes output, deterministic (L155)', () => {
  const plain = render('plain');
  const gh = render('gh', { look_stack: 'golden-hour' });
  const gh2 = render('gh2', { look_stack: 'golden-hour' });

  // (1) WARMTH: whole-frame red rises above blue (plain neutral gray => red ~ blue).
  const pAll = meanRGB(plain, 1, `crop=${W}:${H}:0:0`);
  const gAll = meanRGB(gh, 1, `crop=${W}:${H}:0:0`);
  assert.ok(Math.abs(pAll.r - pAll.b) < 4, 'plain frame is neutral (red ~ blue)');
  assert.ok((gAll.r - gAll.b) - (pAll.r - pAll.b) > 6, `golden-hour warms the frame (red-blue shift ${((gAll.r - gAll.b) - (pAll.r - pAll.b)).toFixed(1)})`);

  // (2) VIGNETTE: a top-left corner region gets darker than the same corner without the look.
  const CORNER = 'crop=36:36:2:2';
  const pCorner = luma(meanRGB(plain, 1, CORNER));
  const gCorner = luma(meanRGB(gh, 1, CORNER));
  assert.ok(gCorner < pCorner - 5, `vignette darkens the corner (plain ${pCorner.toFixed(1)} -> golden-hour ${gCorner.toFixed(1)})`);

  assert.notEqual(hashFile(gh), hashFile(plain), 'golden-hour changed the rendered output vs no look');
  assert.equal(hashFile(gh), hashFile(gh2), 'two golden-hour renders of the same EDL are byte-identical');
});
