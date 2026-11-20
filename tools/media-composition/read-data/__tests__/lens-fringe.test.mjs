/**
 * #161 Lens fringe (radial chromatic aberration): split the color channels RADIALLY, zero at the center and
 * growing toward the corners, so the frame gets the real cheap-lens / VHS color fringe at its edges. Red
 * samples a point pushed OUTWARD from center by (1 + strength*normRadius), blue pushed INWARD; green unchanged.
 * Distinct from the UNIFORM chromatic-aberration grade preset and from #155 beat glitch (uniform horizontal).
 *
 * Proof: DATA resolution (nested {strength} + flat lens_fringe_strength; strength <= 0 dropped; clamps to 0.2),
 * materialize pass-through, AND a real offline render where a white block at a CORNER gets a strong color
 * fringe (|R-B|) at its edge while an identical block at the CENTER stays near-clean (radius-dependent, L155).
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
const W = 320;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
function frame(file, ss) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}
// max |R-B| color fringe across a horizontal scan [x0,x1) at row y
function fringe(raw, x0, x1, y) {
  let m = 0; for (let x = x0; x < x1; x++) { const i = (y * W + x) * 3; if (i + 2 < raw.length) m = Math.max(m, Math.abs(raw[i] - raw[i + 2])); }
  return m;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'lf-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'lf-render-'));
  src = join(work, 'blocks.mp4'); // white block at top-left corner (10..50) AND at center (140..180,100..140)
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=320x240:d=2:r=24',
    '-vf', 'drawbox=x=10:y=10:w=40:h=40:color=white:t=fill,drawbox=x=140:y=100:w=40:h=40:color=white:t=fill,format=yuv420p', src]);
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
  const { edl } = materializeExportEdl(comp, () => src, { width: 320, height: 240, fps: 24 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves lensFringe: nested {strength} + flat lens_fringe_strength; strength <= 0 dropped; clamps to 0.2', () => {
  assert.deepEqual(clipTx(view([setTx({ lensFringe: { strength: 0.06 } })])).lensFringe, { strength: 0.06 });
  assert.deepEqual(clipTx(view([setTx({ lens_fringe_strength: 0.5 })])).lensFringe, { strength: 0.2 }); // clamped
  assert.equal(clipTx(view([setTx({ lensFringe: { strength: 0 } })])).lensFringe, undefined);
  assert.equal(clipTx(view([setTx({ lensFringe: { strength: -1 } })])).lensFringe, undefined);
});

test('materialize emits lens_fringe (snake-cased top-level, nested verbatim)', () => {
  const comp = composeTimeline(view([setTx({ lensFringe: { strength: 0.05 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].lens_fringe, { strength: 0.05 });
});

test('OFFLINE RENDER: a CORNER block fringes and a CENTER block stays clean (radius-dependent, L155)', () => {
  const out = render({ lensFringe: { strength: 0.06 } }, 'lf');
  const f = frame(out, 0.0);
  const cornerFringe = fringe(f, 44, 60, 30);   // right edge of the top-left corner block (far from center)
  const centerFringe = fringe(f, 174, 190, 120); // right edge of the center block (near center)
  assert.ok(cornerFringe > 120, `corner block has a strong color fringe: ${cornerFringe}`);
  assert.ok(centerFringe < 60, `center block stays near-clean: ${centerFringe}`);
  assert.ok(cornerFringe > centerFringe + 60, `fringe grows with radius: corner=${cornerFringe} center=${centerFringe}`);
});

test('OFFLINE RENDER: no lens fringe leaves the corner block edge clean (regression)', () => {
  const out = render({}, 'lf-off');
  const f = frame(out, 0.0);
  assert.ok(fringe(f, 44, 60, 30) < 40, 'corner block edge is clean without lens fringe');
});
