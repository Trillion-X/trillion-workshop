/**
 * #201 Spotlight breathe (`spotlight.pulse`). The existing #125 spotlight is a positioned radial focus
 * (a `vignette=x0:y0:a` darkening away from cx,cy) and #154 animates its POSITION over a keyframed track.
 * #201 is the temporal generalization of the FALLOFF: a positive `pulse` (cycles/sec) sinusoidally
 * modulates the darkening ANGLE over time (a='<base>+<amp>*sin(<w>*t)', eval=frame), so the focus THROBS,
 * a tension/heartbeat move neither the static center nor the moving track can do. It AMPLIFIES the
 * existing spotlight primitive (a new field on it), not a parallel vignette effect (a centered spotlight
 * already IS a centered vignette). Every value is numeric + clamped, so the a= expression carries no free
 * text (injection-safe). Blind DATA (L090).
 *
 * Proof: DATA resolution (nested + flat + clamp + kept-only-when-positive + static spotlight has no pulse),
 * materialize pass-through, AND a real OFFLINE render (deterministic mode #170) where a pulsed centered
 * spotlight makes the whole-frame darkening BREATHE, the frame mean at the sine peak (t=0.25) differs from
 * the trough (t=0.75), a genuine cross-frame pixel diff, while a non-pulsed spotlight holds steady (L155).
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
let work, gray24;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
// whole-frame mean luma at time ss (gray8 raw bytes, stride 1).
function frameMean(file, ss) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22 });
  let s = 0; for (let i = 0; i < raw.length; i++) s += raw[i];
  return s / raw.length;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'spot-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'spot-render-'));
  gray24 = join(work, 'gray24.mp4'); // flat mid-gray @24fps so the breathing modulation is unambiguous
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x808080:s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', gray24]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'g.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-11T00:00:00.000Z', parameters: params });
const clipTx = (v) => composeTimeline(v).lanes.find((l) => l.role === 'video').clips[0].transform;

const render = (params, name) => {
  const comp = composeTimeline(view([setTx(params)]));
  const { edl } = materializeExportEdl(comp, () => gray24, { width: 320, height: 240, fps: 24, deterministic: true });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves spotlight.pulse: nested + flat; clamps 0..10; kept only when positive; static spotlight has none', () => {
  assert.equal(clipTx(view([setTx({ spotlight: { strength: 0.5, pulse: 2 } })])).spotlight.pulse, 2);
  assert.equal(clipTx(view([setTx({ spotlight_strength: 0.5, spotlight_pulse: 3 })])).spotlight.pulse, 3); // flat
  assert.equal(clipTx(view([setTx({ spotlight: { strength: 0.5, pulse: 99 } })])).spotlight.pulse, 10); // clamped
  assert.equal(clipTx(view([setTx({ spotlight: { strength: 0.5, pulse: 0 } })])).spotlight.pulse, undefined); // 0 dropped
  assert.equal(clipTx(view([setTx({ spotlight: { strength: 0.5 } })])).spotlight.pulse, undefined); // no pulse = static
  // pulse without a spotlight strength does nothing (spotlight itself is off).
  assert.equal(clipTx(view([setTx({ spotlight: { strength: 0, pulse: 4 } })])).spotlight, undefined);
});

test('materialize emits spotlight.pulse (existing spotlight field, nested pulse verbatim)', () => {
  const comp = composeTimeline(view([setTx({ spotlight: { strength: 0.6, pulse: 2 } })]));
  const { edl } = materializeExportEdl(comp, () => 'g.mp4', {});
  assert.equal(edl.spine.segments[0].spotlight.pulse, 2);
  assert.equal(edl.spine.segments[0].spotlight.strength, 0.6);
});

test('OFFLINE RENDER: a PULSED spotlight breathes over time; a static one holds steady (L155 temporal)', () => {
  // static centered spotlight: darkening is constant, so peak-phase and trough-phase frames match.
  const still = render({ spotlight: { strength: 0.4 } }, 'spot-static');
  const sPeak = frameMean(still, 0.25);
  const sTrough = frameMean(still, 0.75);
  assert.ok(Math.abs(sPeak - sTrough) < 3, `static spotlight holds steady: t0.25=${sPeak.toFixed(2)} t0.75=${sTrough.toFixed(2)}`);

  // pulsed centered spotlight @1Hz: the falloff angle breathes, so the whole-frame mean shifts between
  // the sine peak (t=0.25, deepest darkening) and trough (t=0.75, shallowest).
  const breathe = render({ spotlight: { strength: 0.4, pulse: 1 } }, 'spot-pulse');
  const bPeak = frameMean(breathe, 0.25);
  const bTrough = frameMean(breathe, 0.75);
  assert.ok(bTrough - bPeak > 3, `pulse breathes: trough(${bTrough.toFixed(2)}) brighter than peak(${bPeak.toFixed(2)})`);
});
