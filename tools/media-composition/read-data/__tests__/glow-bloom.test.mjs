/**
 * #122 Self-glow / bloom (the CapCut "Glow" / cinematic bloom): the clip's own bright areas bleed a soft
 * halo. Screen-blends a blurred copy of the clip over itself, so only highlights bloom. NOT a LOOK_CATALOG
 * row (it needs a parallel split/blend graph, not a linear filter); a legitimate new render primitive over
 * one self-contained filtergraph, blind DATA (L069/L090).
 *
 * Proof (L155): DATA resolution + strength clamp, materialize snake_case pass-through, AND a real offline
 * render where the RING of black pixels around a bright square lights up (the bloom halo) and stronger
 * glow lights it more.
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
let work, spot;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
// Mean gray of a rect at 0.5s.
function grayMean(file, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', file,
    '-vf', `format=gray,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let s = 0;
  for (let i = 0; i < raw.length; i++) s += raw[i];
  return s / raw.length;
}
// The halo ring: a 40px band just OUTSIDE the central bright square, sampled top-left of the square.
const RING = { x: 40, y: 40, w: 20, h: 20 };   // was black in the source
const CORE = { x: 90, y: 90, w: 20, h: 20 };    // the bright square center

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'glow-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'glow-render-'));
  spot = join(work, 'spot.mp4');
  // A small bright white 80x80 square centered on a 200x200 black frame. Glow must bleed the white into
  // the surrounding black (the ring at x40,y40 is well outside the square, which spans 60..140).
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=200x200:r=24:d=1',
    '-vf', 'drawbox=x=60:y=60:w=80:h=80:color=white:t=fill', '-pix_fmt', 'yuv420p', spot]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 1, source_ref: { artifact_ref: 's.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view(params ? [setTx(params)] : []));
  const { edl } = materializeExportEdl(comp, () => spot, { width: 200, height: 200, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('glow + glow_strength resolve onto the clip transform', () => {
  const t = clipTx(view([setTx({ glow: true, glow_strength: 0.8 })]));
  assert.equal(t.glow, true);
  assert.equal(t.glowStrength, 0.8);
});

test('glow_strength clamps to 0..1', () => {
  assert.equal(clipTx(view([setTx({ glow: true, glow_strength: 5 })])).glowStrength, 1);
  assert.equal(clipTx(view([setTx({ glow: true, glow_strength: -2 })])).glowStrength, 0);
});

test('materialize emits glow + glow_strength (snake_case) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ glow: true, glow_strength: 0.6 })]));
  const { edl } = materializeExportEdl(comp, () => 's.mp4', {});
  assert.equal(edl.spine.segments[0].glow, true);
  assert.equal(edl.spine.segments[0].glow_strength, 0.6);
});

test('OFFLINE RENDER: the plain clip has a black ring around the bright square (L155)', () => {
  const ring = grayMean(render(null, 'plain'), RING);
  assert.ok(ring < 8, `the source ring is black, got ${ring.toFixed(1)}`);
});

test('OFFLINE RENDER: glow blooms the highlight into the surrounding black ring (L155)', () => {
  const plainRing = grayMean(render(null, 'g-plain'), RING);
  const glowRing = grayMean(render({ glow: true, glow_strength: 0.8 }, 'g-on'), RING);
  assert.ok(glowRing > plainRing + 10, `glow lights the ring: ${glowRing.toFixed(1)} vs ${plainRing.toFixed(1)}`);
});

test('OFFLINE RENDER: stronger glow blooms the ring more than weak glow (L155)', () => {
  const weak = grayMean(render({ glow: true, glow_strength: 0.2 }, 'g-weak'), RING);
  const strong = grayMean(render({ glow: true, glow_strength: 1 }, 'g-strong'), RING);
  assert.ok(strong > weak, `strength scales the bloom: strong ${strong.toFixed(1)} > weak ${weak.toFixed(1)}`);
});
