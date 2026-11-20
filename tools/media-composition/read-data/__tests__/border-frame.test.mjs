/**
 * #124 Border / frame: draw a solid colored border inside the clip's edges (a common social/meme frame),
 * as blind DATA over one drawbox filter pushed after every effect. width px + a DATA color (sanitized).
 *
 * Proof (L155): DATA resolution (nested/flat, width>0 gate, stroke alias, color sanitize), materialize
 * object pass-through, AND a real offline render where the edge band becomes the border color while the
 * center stays the source color.
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
let work, blue;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function meanRGB(file, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', file,
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n };
}
const dominant = (c) => (c.r > c.g && c.r > c.b ? 'red' : c.g > c.r && c.g > c.b ? 'green' : c.b > c.r && c.b > c.g ? 'blue' : 'gray');
const isWhite = (c) => c.r > 200 && c.g > 200 && c.b > 200;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'border-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'border-render-'));
  blue = join(work, 'blue.mp4');
  // A solid blue 200x200 frame: a border must recolor the edges while the center stays blue.
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x0000E0:s=200x200:r=24:d=1', '-pix_fmt', 'yuv420p', blue]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'b.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => blue, { width: 200, height: 200, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('border resolves from a nested {width,color} object', () => {
  assert.deepEqual(clipTx(view([setTx({ border: { width: 10, color: 'red' } })])).border, { width: 10, color: 'red' });
});

test('border resolves from flat border_width/border_color; stroke aliases width; default color white', () => {
  assert.deepEqual(clipTx(view([setTx({ border_width: 8, border_color: 'yellow' })])).border, { width: 8, color: 'yellow' });
  assert.deepEqual(clipTx(view([setTx({ stroke: 6 })])).border, { width: 6, color: 'white' });
});

test('width 0 is identity and dropped', () => {
  assert.equal(clipTx(view([setTx({ border: { width: 0, color: 'red' } })])).border, undefined);
});

test('materialize emits border (snake_case object) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ border: { width: 12, color: 'white' } })]));
  const { edl } = materializeExportEdl(comp, () => 'b.mp4', {});
  assert.deepEqual(edl.spine.segments[0].border, { width: 12, color: 'white' });
});

test('OFFLINE RENDER: the plain clip is blue at both edge and center (L155)', () => {
  const out = render(null, 'plain');
  assert.equal(dominant(meanRGB(out, { x: 0, y: 90, w: 8, h: 20 })), 'blue');
  assert.equal(dominant(meanRGB(out, { x: 90, y: 90, w: 20, h: 20 })), 'blue');
});

test('OFFLINE RENDER: a white border recolors the edge to white but leaves the center blue (L155)', () => {
  const out = render({ border: { width: 16, color: 'white' } }, 'white-border');
  const edge = meanRGB(out, { x: 0, y: 90, w: 8, h: 20 });   // inside the 16px border band
  const center = meanRGB(out, { x: 90, y: 90, w: 20, h: 20 });
  assert.ok(isWhite(edge), `edge is the border color (white): ${JSON.stringify(edge)}`);
  assert.equal(dominant(center), 'blue', `center stays the source: ${JSON.stringify(center)}`);
});

test('OFFLINE RENDER: a red border recolors the edge red (color is DATA) (L155)', () => {
  const edge = meanRGB(render({ border: { width: 16, color: 'red' } }, 'red-border'), { x: 0, y: 90, w: 8, h: 20 });
  assert.equal(dominant(edge), 'red', `edge is red: ${JSON.stringify(edge)}`);
});

test('a filter-injection color is rejected (falls back to white at render)', () => {
  // The reducer keeps the raw string; the RENDER sanitizes. Prove the render does not honor a hostile
  // color by checking the edge is white (fallback), not transparent/errored.
  const edge = meanRGB(render({ border: { width: 16, color: 'red,hflip' } }, 'evil-border'), { x: 0, y: 90, w: 8, h: 20 });
  assert.ok(isWhite(edge), `hostile color falls back to white: ${JSON.stringify(edge)}`);
});
