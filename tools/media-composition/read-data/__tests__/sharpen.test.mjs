/**
 * #123 Sharpen / clarity (the CapCut "Sharpen" daily driver): crispen edge detail via an unsharp mask on
 * luma. `sharpen` 0..1 scales the amount. A linear detail control (its own continuous field like
 * colorAdjust), distinct from the color looks and from the parallel-graph glow. Blind DATA (L069/L090).
 *
 * Proof (L155): DATA resolution + identity drop + clamp, materialize pass-through, AND a real offline
 * render where sharpening a two-tone edge adds overshoot/undershoot (ringing), so the stddev of a band
 * crossing the edge rises and stronger sharpen rings more.
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
let work, edge;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
// Stddev of a gray band at 0.5s: a sharpened edge rings (overshoot/undershoot), raising local variance.
function bandStddev(file, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', file,
    '-vf', `format=gray,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0;
  for (let i = 0; i < raw.length; i++) s += raw[i];
  const mean = s / raw.length;
  let v = 0;
  for (let i = 0; i < raw.length; i++) v += (raw[i] - mean) ** 2;
  return Math.sqrt(v / raw.length);
}
// A 60px band centered on the vertical edge at x=100.
const EDGE_BAND = { x: 70, y: 0, w: 60, h: 200 };

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'sharp-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'sharp-render-'));
  edge = join(work, 'edge.mp4');
  // A crisp vertical edge: left half gray 96, right half gray 176. unsharp adds ringing at x=100.
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=200x200:r=24:d=1',
    '-vf', 'drawbox=x=0:y=0:w=100:h=200:color=0x606060:t=fill,drawbox=x=100:y=0:w=100:h=200:color=0xB0B0B0:t=fill',
    '-pix_fmt', 'yuv420p', edge]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 'e.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => edge, { width: 200, height: 200, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('sharpen resolves onto the clip transform', () => {
  assert.equal(clipTx(view([setTx({ sharpen: 0.7 })])).sharpen, 0.7);
});

test('sharpen 0 is identity and dropped; >1 clamps to 1', () => {
  assert.equal(clipTx(view([setTx({ sharpen: 0 })])).sharpen, undefined);
  assert.equal(clipTx(view([setTx({ sharpen: 3 })])).sharpen, 1);
});

test('materialize emits sharpen (snake_case) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ sharpen: 0.5 })]));
  const { edl } = materializeExportEdl(comp, () => 'e.mp4', {});
  assert.equal(edl.spine.segments[0].sharpen, 0.5);
});

test('OFFLINE RENDER: sharpen raises the edge-band variance (ringing) vs the plain edge (L155)', () => {
  const plain = bandStddev(render(null, 'plain'), EDGE_BAND);
  const sharp = bandStddev(render({ sharpen: 1 }, 'sharp'), EDGE_BAND);
  assert.ok(sharp > plain + 2, `sharpen adds edge ringing: stddev ${sharp.toFixed(2)} > ${plain.toFixed(2)}`);
});

test('OFFLINE RENDER: stronger sharpen rings more than weak sharpen (L155)', () => {
  const weak = bandStddev(render({ sharpen: 0.2 }, 'weak'), EDGE_BAND);
  const strong = bandStddev(render({ sharpen: 1 }, 'strong'), EDGE_BAND);
  assert.ok(strong > weak, `amount scales the ringing: strong ${strong.toFixed(2)} > weak ${weak.toFixed(2)}`);
});
