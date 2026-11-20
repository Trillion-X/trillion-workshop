/**
 * #214 Retime-to-fit: make a clip fit an EXACT target duration by computing the constant speed factor
 * (speed = srcDur/targetDur) and setting it as the clip's `speed`, which video-compose already applies. The
 * TIME-dimension assembly primitive (drop a clip into a fixed slot / music beat). Zero new render code (L069).
 *
 * Proof (L155): a 3s source clip. (1) PURE unit: speedToFitDuration maps src->target and clamps out-of-range
 * requests (flagging achievable:false). (2) OFFLINE RENDER: fit to 2s (speed 1.5) and to 4s (speed 0.75) and
 * the rendered output DURATION equals the target, byte-deterministic.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { blake3 } from '@noble/hashes/blake3.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { speedToFitDuration, fitToDuration } from '../../do-work/retime-to-fit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
const W = 240, H = 160, FPS = 24;
let composeTimeline, materializeExportEdl, work, clip;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const hashFile = (file) => '1f:' + Buffer.from(blake3(new Uint8Array(readFileSync(file)))).toString('hex');
const durOf = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'fit-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'fit-render-'));
  clip = join(work, 'clip.mp4'); // exactly 3s of video + audio
  ffmpeg(['-f', 'lavfi', '-i', `testsrc=s=${W}x${H}:d=3:r=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=440:d=3',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
});

const view = () => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 3, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }],
  editDecisions: [], markers: [],
});
const renderAtSpeed = (name, speed) => {
  const comp = composeTimeline(view());
  const { edl } = materializeExportEdl(comp, () => clip, { width: W, height: H, fps: FPS, deterministic: true });
  edl.spine.segments[0].speed = speed; // caller sets the fit speed; video-compose applies setpts+atempo
  const f = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });
  return out;
};

test('PURE unit: speedToFitDuration maps src->target and clamps out-of-range requests', () => {
  assert.deepEqual(speedToFitDuration(3, 2), { speed: 1.5, achievable: true, requestedSpeed: 1.5 });   // speed up
  assert.deepEqual(speedToFitDuration(3, 4), { speed: 0.75, achievable: true, requestedSpeed: 0.75 });  // slow down
  assert.deepEqual(speedToFitDuration(3, 3), { speed: 1, achievable: true, requestedSpeed: 1 });        // identity
  const tooShort = speedToFitDuration(3, 0.1); // needs 30x, clamped to max 8
  assert.equal(tooShort.speed, 8); assert.equal(tooShort.achievable, false); assert.equal(tooShort.requestedSpeed, 30);
  assert.deepEqual(speedToFitDuration(0, 2), { speed: 1, achievable: false, requestedSpeed: 1 });        // no-op
});

test('OFFLINE RENDER: fitting a 3s clip to 2s and to 4s yields exactly those durations, deterministic (L155)', () => {
  const src = durOf(clip);
  assert.ok(Math.abs(src - 3) < 0.1, `source is ~3s (${src.toFixed(2)})`);

  const to2 = fitToDuration(clip, 2);
  const to4 = fitToDuration(clip, 4);
  assert.equal(to2.speed, 1.5); assert.equal(to4.speed, 0.75);

  const r2 = renderAtSpeed('to2', to2.speed);
  const r4 = renderAtSpeed('to4', to4.speed);
  const r2b = renderAtSpeed('to2b', to2.speed);

  assert.ok(Math.abs(durOf(r2) - 2) < 0.2, `fit-to-2s render is ~2s (${durOf(r2).toFixed(2)})`);
  assert.ok(Math.abs(durOf(r4) - 4) < 0.2, `fit-to-4s render is ~4s (${durOf(r4).toFixed(2)})`);
  assert.equal(hashFile(r2), hashFile(r2b), 'two fit renders at the same speed are byte-identical');
});
