/**
 * #169 Film damage (old-film look): flickering vertical scratch lines and dust specks that jump position each
 * frame. drawbox cannot do this (its x/w expressions split on the comma inside mod/if/lt in a -vf graph), so
 * it is built in geq: the per-frame index is fk = floor(T*fps), each scratch/dust uses a distinct prime seed,
 * and lt(mod(fk*p,10),thr) flickers it on/off. Scratches ADD light (bright vertical lines), dust SUBTRACTS
 * (dark specks).
 *
 * Proof: DATA resolution (nested {scratches,dust,strength} + flat + bare true; counts round+clamp; disabled
 * when both zero), materialize pass-through, AND a real offline render where bright scratch columns appear on
 * a flat mid-gray source and JUMP to different x positions across frames (temporal), while the plain source
 * has none (L155).
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
const W = 320, FPS = 12;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}
// bright column x-positions on the center scanline at time ss (a scratch = a bright vertical line).
function brightCols(file, ss) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-vf', 'format=gray,crop=320:1:0:120', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  const cols = [];
  for (let x = 0; x < raw.length; x++) if (raw[x] > 160) cols.push(x);
  return cols;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'fd-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'fd-render-'));
  gray = join(work, 'gray.mp4'); // flat mid-gray so scratches/dust are unambiguous
  ffmpeg(['-f', 'lavfi', '-i', `color=0x555555:s=320x240:d=2:r=${FPS}`, '-pix_fmt', 'yuv420p', gray]);
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
  // #170: deterministic mode pins filter/encoder threads so this temporal geq render is bit-stable (no flake).
  const { edl } = materializeExportEdl(comp, () => source, { width: 320, height: 240, fps: FPS, deterministic: true });
  const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
};

test('resolves film damage: nested + flat + bare true; counts round/clamp; both-zero disabled', () => {
  assert.deepEqual(clipTx(view([setTx({ film_damage: { scratches: 3, dust: 16, strength: 0.7 } })])).filmDamage, { scratches: 3, dust: 16, strength: 0.7 });
  assert.deepEqual(clipTx(view([setTx({ film_damage_scratches: 2.6 })])).filmDamage, { scratches: 3 }); // rounded
  assert.deepEqual(clipTx(view([setTx({ film_damage: { scratches: 99, dust: 500 } })])).filmDamage, { scratches: 8, dust: 40 }); // clamped
  assert.deepEqual(clipTx(view([setTx({ film_damage: true })])).filmDamage, { scratches: 2, dust: 14 }); // bare true seeds defaults
  assert.equal(clipTx(view([setTx({ film_damage: { scratches: 0, dust: 0 } })])).filmDamage, undefined);
  assert.equal(clipTx(view([setTx({})])).filmDamage, undefined);
});

test('materialize emits film_damage (snake-cased top-level, nested object verbatim)', () => {
  const comp = composeTimeline(view([setTx({ film_damage: { scratches: 3, dust: 16, strength: 0.7 } })]));
  const { edl } = materializeExportEdl(comp, () => 'r.mp4', {});
  assert.deepEqual(edl.spine.segments[0].film_damage, { scratches: 3, dust: 16, strength: 0.7 });
});

test('OFFLINE RENDER: bright scratch columns appear and JUMP position across frames (L155 temporal)', () => {
  // plain gray: no bright columns anywhere.
  const plain = render({}, 'fd-off');
  assert.equal(brightCols(plain, 0.25).length, 0, 'plain gray has no scratches');

  // with many scratches (maximize the chance a scratch is on any given frame) and no dust on this scanline.
  const out = render({ film_damage: { scratches: 8, dust: 0, strength: 1 } }, 'fd-on');
  // sample several frames; collect the set of scratch columns seen per frame.
  const perFrame = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => brightCols(out, n / FPS));
  const framesWithScratch = perFrame.filter((c) => c.length > 0);
  assert.ok(framesWithScratch.length >= 3, `scratches appear on multiple frames: ${perFrame.map((c) => c.length)}`);
  // the columns are not all the same position: gather distinct first-columns across frames that had one.
  const firstCols = new Set(framesWithScratch.map((c) => c[0]));
  assert.ok(firstCols.size >= 2, `scratch columns JUMP across frames (temporal): distinct first-cols=${[...firstCols]}`);
});
