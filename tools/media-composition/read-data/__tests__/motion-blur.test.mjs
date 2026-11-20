/**
 * Motion blur / frame-blend (the After Effects / DaVinci "frame blend" look) as a per-clip DATA flag.
 * `motionBlur` blends the last N frames (`tmix=frames=N`) into each output frame so fast motion reads
 * as a smear. It is the complement of `speedSmooth` (interpolation for slow-downs). Zero engine
 * branching: a DATA flag + one render filter (L069/L090).
 *
 * Proof: DATA resolution, materialize snake_case pass-through, AND a real offline render where a fast
 * white box gets smeared, so the count of near-full-bright pixels collapses vs the sharp render (L155).
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
let work, movebox;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
}

// Count near-full-bright (>200) pixels in the frame at `seek` seconds (default 1s, mid-clip, so
// tmix has real frame history to blend): a compact sharp box has many; a smeared box has few (each
// position averaged toward black). Frame 0 is unusable: tmix has no prior frames there.
function brightCount(file, seek = 1) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(seek), '-i', file,
    '-vf', 'format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let n = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] > 200) n++;
  return n;
}

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'mblur-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'mblur-render-'));
  movebox = join(work, 'movebox.mp4');
  // A 40x40 white box sweeping fast (480 px/s) across a black frame via overlay (whose x supports a
  // per-frame `t` expression, unlike drawbox on a color source), so consecutive frames are far apart
  // and tmix genuinely smears them.
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=320x180:r=24:d=2',
    '-f', 'lavfi', '-i', 'color=white:s=40x40:r=24:d=2',
    '-filter_complex', '[0][1]overlay=x=mod(t*480\\,280):y=70',
    '-pix_fmt', 'yuv420p', movebox]);
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 2, source_ref: { artifact_ref: 'box.mp4', source_id: 's1' } },
  ] }],
  editDecisions: decisions,
  markers: [],
});
const setTx = (params) => ({ action: 'set-transform', label: 'set-transform', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-07T00:00:00.000Z', parameters: params });

test('motion_blur + motion_blur_frames resolve onto the clip transform', () => {
  const comp = composeTimeline(view([setTx({ motion_blur: true, motion_blur_frames: 5 })]));
  const clip = comp.lanes.find((l) => l.role === 'video').clips[0];
  assert.equal(clip.transform.motionBlur, true);
  assert.equal(clip.transform.motionBlurFrames, 5);
});

test('a motion_blur_frames below 2 is ignored (needs >= 2 frames to blend)', () => {
  const comp = composeTimeline(view([setTx({ motion_blur: true, motion_blur_frames: 1 })]));
  const clip = comp.lanes.find((l) => l.role === 'video').clips[0];
  assert.equal(clip.transform.motionBlur, true);
  assert.equal(clip.transform.motionBlurFrames, undefined);
});

test('materialize emits motion_blur (snake_case) on the EDL clip', () => {
  const comp = composeTimeline(view([setTx({ motion_blur: true, motion_blur_frames: 6 })]));
  const { edl } = materializeExportEdl(comp, () => 'box.mp4', {});
  const seg = edl.spine.segments[0];
  assert.equal(seg.motion_blur, true);
  assert.equal(seg.motion_blur_frames, 6);
});

test('OFFLINE RENDER: motion blur smears a fast box so near-full-bright pixels collapse (L155)', () => {
  const render = (params, name) => {
    const comp = composeTimeline(view(params ? [setTx(params)] : []));
    const { edl } = materializeExportEdl(comp, () => movebox, { width: 320, height: 180, fps: 24 });
    const edlFile = join(work, `${name}.json`); const out = join(work, `${name}.mp4`);
    writeFileSync(edlFile, JSON.stringify(edl));
    execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
    return out;
  };
  const sharp = brightCount(render(null, 'sharp'));
  const blurred = brightCount(render({ motion_blur: true, motion_blur_frames: 6 }, 'blurred'));
  assert.ok(sharp > 400, `the sharp box has many full-bright pixels, got ${sharp}`);
  assert.ok(blurred < sharp * 0.5, `motion blur dims the smeared box: blurred ${blurred} << sharp ${sharp}`);
});
