/**
 * #162 Posterize: quantize each color channel to `levels` discrete steps, flattening smooth gradients into
 * bands (the poster / comic / retro-print look). step = 255/(levels-1); each channel maps to
 * min(255, round(v/step)*step). Distinct from the CONTINUOUS grade/colorAdjust (curves, eq): this reduces
 * the NUMBER of colors, not their curve.
 *
 * Proof: DATA resolution (nested {levels} + flat posterize_levels; levels < 2 dropped; clamps to 2..64,
 * rounds), materialize pass-through, AND a real offline render on a smooth gradient where the number of
 * distinct color values collapses to about `levels` while the original has many (L155).
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
let work, grad;
const W = 320;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
function distinctR(raw, y) {
  const s = new Set(); for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; if (i < raw.length) s.add(raw[i]); }
  return s.size;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'post-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'post-render-'));
  grad = join(work, 'grad.mp4'); // smooth horizontal black->white gradient (many distinct values)
  // An EXACT ramp, computed per pixel, which is the source convention the rest of this suite
  // folder already uses. `gradients` is a RANDOM-gradient generator: it draws a different pattern
  // per run, so a test counting distinct luma values was counting whatever that run happened to
  // draw. This one was red in the corpus for exactly that reason.
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

test('resolves posterize: nested {levels} + flat posterize_levels; levels < 2 dropped; clamps 2..64 + rounds', () => {
  assert.deepEqual(clipTx(view([setTx({ posterize: { levels: 6 } })])).posterize, { levels: 6 });
  assert.deepEqual(clipTx(view([setTx({ posterize_levels: 3.7 })])).posterize, { levels: 4 }); // rounded
  assert.deepEqual(clipTx(view([setTx({ posterize: { levels: 200 } })])).posterize, { levels: 64 }); // clamped
  assert.equal(clipTx(view([setTx({ posterize: { levels: 1 } })])).posterize, undefined); // < 2 dropped
});

test('materialize emits posterize (snake-cased top-level, nested verbatim)', () => {
  const comp = composeTimeline(view([setTx({ posterize: { levels: 5 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].posterize, { levels: 5 });
});

test('OFFLINE RENDER: a smooth gradient collapses to about `levels` distinct values (L155)', () => {
  const out = render({ posterize: { levels: 5 } }, 'post');
  const plain = render({}, 'post-off');
  const posterized = distinctR(frame(out, 0.0), 120);
  const original = distinctR(frame(plain, 0.0), 120);
  assert.ok(original > 40, `original gradient has many distinct values: ${original}`);
  assert.ok(posterized <= 8, `posterized collapses to about the level count: ${posterized}`);
});
