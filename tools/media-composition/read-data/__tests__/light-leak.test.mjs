/**
 * #168 Light leak: a soft colored bloom of light bleeding in from a point (the film "light leak" look). A
 * radial falloff A = strength*max(0, 1 - dist/radiusPx) around (x,y) is screen-blended with the leak color,
 * so the frame is LIGHTENED toward the color, strongest at the point and fading to identity far away. It ADDS
 * colored light (distinct from spotlight which darkens, and scrim which is a linear edge darken).
 *
 * Proof: DATA resolution (nested {strength,color,x,y,radius} + flat light_leak_*; strength<=0 dropped;
 * strength/x/y/radius clamp 0..1; color kept as free text), materialize pass-through, AND a real offline
 * render on a dark-gray source where the leak corner is lightened toward the color while the far corner is
 * unchanged, and the color is real DATA (a warm leak raises R, a cool leak raises B) (L155).
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
// mean RGB of a small block at (x,y)
function px(file, x, y) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `format=rgb24,crop=6:6:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) { r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n };
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'll-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'll-render-'));
  gray = join(work, 'gray.mp4'); // dark gray so a lightening leak is unambiguous
  ffmpeg(['-f', 'lavfi', '-i', 'color=0x404040:s=320x240:d=2:r=12', '-pix_fmt', 'yuv420p', gray]);
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
  const { edl } = materializeExportEdl(comp, () => source, { width: 320, height: 240, fps: 12 });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves light leak: nested + flat; strength<=0 dropped; clamps 0..1; color kept', () => {
  assert.deepEqual(clipTx(view([setTx({ light_leak: { strength: 0.8, color: '#ff9628', x: 1, y: 0, radius: 0.75 } })])).lightLeak,
    { strength: 0.8, color: '#ff9628', x: 1, y: 0, radius: 0.75 });
  assert.deepEqual(clipTx(view([setTx({ light_leak_strength: 0.5, light_leak_color: 'red' })])).lightLeak, { strength: 0.5, color: 'red' });
  assert.deepEqual(clipTx(view([setTx({ light_leak: { strength: 5, x: 9, y: -2, radius: 3 } })])).lightLeak, { strength: 1, x: 1, y: 0, radius: 1 });
  assert.equal(clipTx(view([setTx({ light_leak: { strength: 0 } })])).lightLeak, undefined);
  assert.equal(clipTx(view([setTx({})])).lightLeak, undefined);
});

test('materialize emits light_leak (snake-cased top-level, nested object verbatim)', () => {
  const comp = composeTimeline(view([setTx({ light_leak: { strength: 0.8, color: '#ff9628', x: 1, y: 0 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].light_leak, { strength: 0.8, color: '#ff9628', x: 1, y: 0 });
});

test('OFFLINE RENDER: the leak corner is lightened toward the color, the far corner is unchanged (L155)', () => {
  const base = px(render({}, 'll-off'), 300, 8);       // top-right of the plain gray (should be ~64,64,64)
  const out = render({ light_leak: { strength: 0.85, color: '#ff9628', x: 1, y: 0, radius: 0.75 } }, 'll-warm');
  const nearLeak = px(out, 300, 8);   // top-right corner (source of the leak)
  const farCorner = px(out, 8, 228);  // bottom-left (far from the leak)
  // near the leak: much brighter and warm (R up strongly, R > B since the color is warm orange).
  assert.ok(nearLeak.r > base.r + 60, `leak corner is lightened: base.R=${base.r.toFixed(0)} leak.R=${nearLeak.r.toFixed(0)}`);
  assert.ok(nearLeak.r - nearLeak.b > 60, `leak is warm (R dominates B): R=${nearLeak.r.toFixed(0)} B=${nearLeak.b.toFixed(0)}`);
  // far corner: essentially the untouched gray.
  assert.ok(Math.abs(farCorner.r - 64) < 14 && Math.abs(farCorner.r - farCorner.b) < 10, `far corner is unchanged gray: R=${farCorner.r.toFixed(0)} B=${farCorner.b.toFixed(0)}`);
});

test('OFFLINE RENDER: a cool leak raises B instead of R (proves color is real DATA)', () => {
  const out = render({ light_leak: { strength: 0.85, color: '#3aa0ff', x: 1, y: 0, radius: 0.75 } }, 'll-cool');
  const nearLeak = px(out, 300, 8);
  assert.ok(nearLeak.b - nearLeak.r > 50, `cool leak: B dominates R: R=${nearLeak.r.toFixed(0)} B=${nearLeak.b.toFixed(0)}`);
});
