/**
 * #152 Gradient scrim: a linear darken/tint ramp toward one edge, for caption legibility (the lower-third
 * "scrim" every captioned video needs). DATA `scrim` true (default bottom/0.6/black) OR {edge, strength, color}.
 * A computed X/Y ramp the UNIFORM `grade` seam cannot express: per-pixel blend toward the scrim color with
 * opacity strength*ramp (ramp = Y/H bottom, 1-Y/H top, X/W right, 1-X/W left).
 *
 * Proof: DATA resolution (edge clamp, strength clamp, color, boolean true), materialize pass-through, AND real
 * offline renders where the scrim EDGE is darkened while the OPPOSITE edge is unchanged, and a color scrim
 * tints toward that color.
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
let work, src;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function meanRGB(file, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  const n = raw.length / 3;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}
const lumOf = (c) => (c.r + c.g + c.b) / 3;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'scrim-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'scrim-render-'));
  src = join(work, 'gray.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=gray:s=320x240:d=1:r=12', '-pix_fmt', 'yuv420p', src]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-08T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => src, { width: 320, height: 240, fps: 12 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves edge (clamped) + strength (clamped) + color; boolean true -> default; presence turns it on', () => {
  assert.deepEqual(clipTx(view([setTx({ scrim: { edge: 'top', strength: 0.5, color: 'red' } })])).scrim, { edge: 'top', strength: 0.5, color: 'red' });
  assert.deepEqual(clipTx(view([setTx({ scrim: { edge: 'sideways', strength: 5 } })])).scrim, { strength: 1 }); // bad edge dropped, strength clamped
  assert.deepEqual(clipTx(view([setTx({ scrim: true })])).scrim, {});
  assert.equal(clipTx(view([])).scrim, undefined);
});

test('materialize emits scrim.{edge,strength,color} (nested, verbatim)', () => {
  const comp = composeTimeline(view([setTx({ scrim: { edge: 'bottom', strength: 0.6, color: 'black' } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].scrim, { edge: 'bottom', strength: 0.6, color: 'black' });
});

test('OFFLINE RENDER bottom black scrim: bottom darkened, top unchanged, smooth ramp (L155)', () => {
  const out = render({ scrim: { edge: 'bottom', strength: 0.7 } }, 'scrim-bottom');
  const top = lumOf(meanRGB(out, { x: 140, y: 6, w: 40, h: 8 }));
  const mid = lumOf(meanRGB(out, { x: 140, y: 116, w: 40, h: 8 }));
  const bottom = lumOf(meanRGB(out, { x: 140, y: 228, w: 40, h: 8 }));
  assert.ok(top > 110, `top unchanged (~gray): ${top.toFixed(0)}`);
  assert.ok(bottom < 55, `bottom darkened: ${bottom.toFixed(0)}`);
  assert.ok(mid > bottom + 20 && mid < top - 20, `mid is a smooth ramp between: ${mid.toFixed(0)}`);
});

test('OFFLINE RENDER top color scrim: tints the TOP toward the color, bottom unchanged', () => {
  const out = render({ scrim: { edge: 'top', strength: 0.8, color: 'red' } }, 'scrim-top-red');
  const top = meanRGB(out, { x: 140, y: 6, w: 40, h: 8 });
  const bottom = meanRGB(out, { x: 140, y: 232, w: 40, h: 8 });
  assert.ok(top.r > top.g + 40 && top.r > top.b + 40, `top tinted red: ${JSON.stringify(top)}`);
  assert.ok(Math.abs(bottom.r - bottom.g) < 25, `bottom is unchanged gray: ${JSON.stringify(bottom)}`);
});
