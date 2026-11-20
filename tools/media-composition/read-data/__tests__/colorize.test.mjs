/**
 * #195 Colorize (single-hue wash / monochrome tint): recolor the WHOLE frame toward one hue while keeping its
 * luma, via ffmpeg's native `colorize` filter (the blueprint / cyanotype / sepia / red-alert look). DATA
 * colorize: true | { hue: 0..360, strength: 0..1 }. bare true seeds a blueprint blue { hue 220, strength 0.5 }.
 * A generative primitive: hue is DATA, so the SAME effect produces every named tint (blue, red, green, ...).
 * Distinct from duotone (a 2-color luma ramp) and splitTone (different hues for shadows vs highlights).
 *
 * Proof: DATA resolution (bare true seeds {220,0.5}; nested {hue,strength}; flat colorize_hue/_strength; hue
 * wraps 0..360; strength clamp 0..1; strength 0 dropped), materialize pass-through, AND a real OFFLINE render
 * whose oracle is the TINT DIRECTION: a neutral-gray source (R==G==B) gains a BLUE cast at hue 220 (B >> R) and
 * a RED cast at hue 0 (R >> B), proving both the wash and that the hue is DATA-selected. PLUS a byte-identical
 * determinism proof. L155.
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
let work, gray;
const W = 320, H = 240, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
const digestHex = (file) => Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
function rgbAt(file, ss, x, y) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  const i = (y * W + x) * 3; return { r: raw[i], g: raw[i + 1], b: raw[i + 2] };
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'clz-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'clz-render-'));
  gray = join(work, 'gray.mp4'); // a neutral mid-gray field (R==G==B) so any tint shows up cleanly.
  ffmpeg(['-f', 'lavfi', '-i', `color=0x808080:s=320x240:d=2:r=${FPS}`, '-pix_fmt', 'yuv420p', gray]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'b.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-10T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name, deterministic) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => gray, { width: W, height: H, fps: FPS, deterministic });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves colorize: bare `true` seeds {220,0.5}; nested {hue,strength}; flat colorize_hue/_strength', () => {
  assert.deepEqual(clipTx(view([setTx({ colorize: true })])).colorize, { hue: 220, strength: 0.5 });
  assert.deepEqual(clipTx(view([setTx({ colorize: { hue: 30, strength: 0.8 } })])).colorize, { hue: 30, strength: 0.8 });
  assert.deepEqual(clipTx(view([setTx({ colorize_hue: 120, colorize_strength: 0.3 })])).colorize, { hue: 120, strength: 0.3 });
});

test('resolves colorize: hue wraps 0..360; strength clamps 0..1; strength 0 dropped; absent undefined', () => {
  assert.deepEqual(clipTx(view([setTx({ colorize: { hue: 400, strength: 0.5 } })])).colorize, { hue: 40, strength: 0.5 });
  assert.deepEqual(clipTx(view([setTx({ colorize: { hue: -20, strength: 0.5 } })])).colorize, { hue: 340, strength: 0.5 });
  assert.deepEqual(clipTx(view([setTx({ colorize: { hue: 30, strength: 9 } })])).colorize, { hue: 30, strength: 1 });
  assert.equal(clipTx(view([setTx({ colorize: { hue: 30, strength: 0 } })])).colorize, undefined);
  assert.equal(clipTx(view([setTx({})])).colorize, undefined);
});

test('materialize emits colorize (verbatim, nested value copied as-is)', () => {
  const comp = composeTimeline(view([setTx({ colorize: { hue: 30, strength: 0.8 } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].colorize, { hue: 30, strength: 0.8 });
});

test('OFFLINE RENDER: colorize washes a neutral gray toward the DATA-selected hue (blue at 220, red at 0) (L155)', () => {
  const x = 160, y = 120;
  const base = rgbAt(render({}, 'clz-off', true), 0.5, x, y);
  const blue = rgbAt(render({ colorize: { hue: 220, strength: 0.6 } }, 'clz-blue', true), 0.5, x, y);
  const red = rgbAt(render({ colorize: { hue: 0, strength: 0.6 } }, 'clz-red', true), 0.5, x, y);

  assert.ok(Math.abs(base.r - base.b) < 8, `the base is neutral gray (R~=B): R${base.r} B${base.b}`);
  assert.ok(blue.b > blue.r + 60, `hue 220 gives a BLUE cast (B >> R): R${blue.r} B${blue.b}`);
  assert.ok(red.r > red.b + 60, `hue 0 gives a RED cast (R >> B): R${red.r} B${red.b}`);

  const a = render({ colorize: { hue: 220, strength: 0.6 } }, 'clz-det-a', true);
  const b = render({ colorize: { hue: 220, strength: 0.6 } }, 'clz-det-b', true);
  assert.equal(digestHex(a), digestHex(b), 'two deterministic colorize renders of the same EDL are byte-identical');
});
