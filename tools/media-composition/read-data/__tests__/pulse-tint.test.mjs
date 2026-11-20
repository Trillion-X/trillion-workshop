/**
 * #166 Beat tint pulse: a new `kind: 'tint'` on the pulses DATA array. On each beat the whole frame is
 * blended toward the pulse's `color` (a red/cyan/white beat-flash), the HUE shift the additive `flash`
 * (brightness) kind cannot express. The render resolves color to safe RGB ints (colorToRgb255), groups
 * pulses by color (N beats of one color = one geq pass), and drives the blend with the shared triangular
 * beat envelope; between beats the blend is zero so the frame is untouched.
 *
 * Proof: DATA resolution (kind:'tint' accepted, color kept as free text, non-tint kinds ignore color),
 * materialize pass-through, AND a real offline render on a gray source where the frame IS the tint color at
 * the beat and stays neutral gray off the beat (L155 temporal: the proof samples across time).
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
let work, gray;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
// center pixel (mean of a 4x4 block at frame center) at time ss
function centerPx(file, ss) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24,crop=4:4:158:118', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n };
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'tint-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'tint-render-'));
  gray = join(work, 'gray.mp4'); // flat mid-gray so any color shift is unambiguous
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x808080:s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', gray]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-09T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name, source = gray) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => source, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves tint pulse: kind:tint accepted, color kept; non-tint keeps color as inert DATA', () => {
  const t = clipTx(view([setTx({ pulses: [{ at: 1.0, strength: 0.9, kind: 'tint', color: '#ff2d55' }] })]));
  assert.deepEqual(t.pulses, [{ at: 1.0, strength: 0.9, kind: 'tint', color: '#ff2d55' }]);
  // color survives on a flash pulse too (the render ignores it); the field is generic DATA.
  const f = clipTx(view([setTx({ pulses: [{ at: 0.5, kind: 'flash', color: 'red' }] })]));
  assert.deepEqual(f.pulses, [{ at: 0.5, kind: 'flash', color: 'red' }]);
  // unknown kind is dropped to default (undefined); empty color dropped.
  const u = clipTx(view([setTx({ pulses: [{ at: 0.5, kind: 'zzz', color: '   ' }] })]));
  assert.deepEqual(u.pulses, [{ at: 0.5 }]);
});

test('materialize emits the tint pulse (kind + color) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ pulses: [{ at: 1.0, strength: 0.9, kind: 'tint', color: '#00e5ff' }] })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].pulses, [{ at: 1.0, strength: 0.9, kind: 'tint', color: '#00e5ff' }]);
});

test('OFFLINE RENDER: the frame IS the tint color at the beat and neutral gray off the beat (L155 temporal)', () => {
  const out = render({ pulses: [{ at: 1.0, strength: 0.95, duration: 0.16, kind: 'tint', color: '#ff2d55' }] }, 'tint-red');
  const onBeat = centerPx(out, 1.0);   // peak of the beat
  const offBeat = centerPx(out, 0.4);  // far from any beat
  // at the beat: strongly red (R high, G/B low); the gray was pushed toward #ff2d55 = (255,45,85).
  assert.ok(onBeat.r > 180, `on-beat is red: R=${onBeat.r.toFixed(0)}`);
  assert.ok(onBeat.r - onBeat.g > 90, `on-beat R dominates G (a hue shift, not a brightness flash): R=${onBeat.r.toFixed(0)} G=${onBeat.g.toFixed(0)}`);
  // off the beat: neutral gray (R ~= G ~= B, all near 128).
  assert.ok(Math.abs(offBeat.r - offBeat.g) < 12 && Math.abs(offBeat.g - offBeat.b) < 12, `off-beat is neutral gray: R=${offBeat.r.toFixed(0)} G=${offBeat.g.toFixed(0)} B=${offBeat.b.toFixed(0)}`);
  assert.ok(offBeat.r > 100 && offBeat.r < 156, `off-beat stays mid-gray: R=${offBeat.r.toFixed(0)}`);
});

test('OFFLINE RENDER: a cyan tint shifts the OTHER way (proves color is real DATA, not a fixed red)', () => {
  const out = render({ pulses: [{ at: 1.0, strength: 0.95, duration: 0.16, kind: 'tint', color: '#00e5ff' }] }, 'tint-cyan');
  const onBeat = centerPx(out, 1.0);
  // #00e5ff = (0,229,255): on-beat B and G dominate R.
  assert.ok(onBeat.b > 180 && onBeat.g > 150, `on-beat is cyan: G=${onBeat.g.toFixed(0)} B=${onBeat.b.toFixed(0)}`);
  assert.ok(onBeat.b - onBeat.r > 90, `on-beat B dominates R (cyan, not red): R=${onBeat.r.toFixed(0)} B=${onBeat.b.toFixed(0)}`);
});
