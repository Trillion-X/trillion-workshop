/**
 * #155 Beat glitch (pulse kind 'glitch'): the 4th beat-transient in the pulses family (after flash,
 * punch, shake). At each beat the frame gets a transient horizontal RGB-channel split (chromatic
 * aberration jitter): the red channel samples X+off, the blue X-off, off = MAXPX * the triangular
 * beat envelope. Between beats off is 0 so the frame is clean; AT the beat it splits.
 *
 * A computed-timing primitive the static grade seam cannot express (a static chromatic aberration is
 * just a grade string; this folds an arbitrary beat timestamp list, L069). Proof: DATA resolution
 * (kind glitch accepted, unknown dropped), materialize pass-through, AND a real offline render on a
 * hard red|blue vertical edge where the near-edge pixels are corrupted AT the beat but clean far from
 * it (L155 temporal), while a no-pulse render stays clean at the same spot (regression).
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
function meanRGB(file, ss, { x, y, w, h }) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', `format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let r = 0, g = 0, b = 0; const n = raw.length / 3;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}
const chanDist = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'glch-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'glch-render-'));
  edge = join(work, 'edge.mp4'); // left half red, right half blue: a hard vertical edge at x=160
  ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=160x240:d=2:r=24', '-f', 'lavfi', '-i', 'color=blue:s=160x240:d=2:r=24',
    '-filter_complex', '[0][1]hstack=2', '-pix_fmt', 'yuv420p', edge]);
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
  const { edl } = materializeExportEdl(comp, () => edge, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves kind glitch (accepted alongside flash/punch/shake); unknown kind dropped', () => {
  const a = clipTx(view([setTx({ pulses: [{ at: 1, strength: 0.9, duration: 0.3, kind: 'glitch' }] })])).pulses;
  assert.deepEqual(a, [{ at: 1, strength: 0.9, duration: 0.3, kind: 'glitch' }]);
  const b = clipTx(view([setTx({ pulses: [{ at: 1, kind: 'wobble' }] })])).pulses;
  assert.deepEqual(b, [{ at: 1 }]); // unknown kind dropped, pulse kept
});

test('materialize emits pulses with kind glitch on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ pulses: [{ at: 1, strength: 0.8, kind: 'glitch' }] })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].pulses, [{ at: 1, strength: 0.8, kind: 'glitch' }]);
});

test('OFFLINE RENDER: the RGB split fires AT the beat and is clean far from it (L155 temporal)', () => {
  // beat at t=1.0; near-edge column (x=150..170) is corrupted at the beat, clean at t=0.1.
  const out = render({ pulses: [{ at: 1.0, strength: 1, duration: 0.4, kind: 'glitch' }] }, 'glch');
  const box = { x: 150, y: 110, w: 20, h: 20 };
  const clean = render({}, 'glch-clean'); // no pulses: the same near-edge, never split
  const nearBeat = meanRGB(out, 1.0, box);
  const nearEarly = meanRGB(out, 0.1, box);
  const cleanAtBeat = meanRGB(clean, 1.0, box);
  assert.ok(chanDist(nearBeat, cleanAtBeat) > 40, `edge corrupted at the beat: glitch=${JSON.stringify(nearBeat)} clean=${JSON.stringify(cleanAtBeat)}`);
  assert.ok(chanDist(nearEarly, cleanAtBeat) < 20, `edge clean far from the beat: early=${JSON.stringify(nearEarly)} clean=${JSON.stringify(cleanAtBeat)}`);
});

test('OFFLINE RENDER: a region away from the edge is unaffected by the split (regression)', () => {
  const out = render({ pulses: [{ at: 1.0, strength: 1, duration: 0.4, kind: 'glitch' }] }, 'glch-flat');
  // deep in the flat red region (x=40): a horizontal shift of a uniform area changes nothing.
  const flatBeat = meanRGB(out, 1.0, { x: 30, y: 110, w: 20, h: 20 });
  assert.ok(flatBeat.r > 150 && flatBeat.b < 80, `flat red region stays red through the beat: ${JSON.stringify(flatBeat)}`);
});
