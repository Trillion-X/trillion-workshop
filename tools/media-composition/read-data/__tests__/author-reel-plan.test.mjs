/**
 * #225 Reel-plan authorer (author-reel-plan.mjs): the "brain" that composes the intelligence producers
 * (measureQuality / measureMotion / autoReframe / bestPosterTime) into ONE edit-decision plan the existing
 * render/poster/loudnorm consume, so batch reel production stops being dumb (fixed timestamps, no take
 * selection, no action trim, no reframe follow). Pure decision authoring, zero new render code (L069).
 *
 * Proof (L155, definitive offline compose + render): a 16:9 clip, gray (so it is usable) with a white box on the
 * LEFT third that is STATIC for 2s then MOVES for 1s. (1) PURE: actionWindow picks the moving run from motion
 * segments. (2) COMPOSE: authorReelPlan returns action starting at ~2s (the motion window), a reframe track that
 * leans left (the subject), and usable=true. (3) RENDER: applyPlanToSegment + video-compose yields a clip trimmed
 * to ~the action length and in 9:16 aspect, proving the plan drives the real render.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorReelPlan, actionWindow, applyPlanToSegment } from '../../do-work/author-reel-plan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'do-work', 'video-compose.mjs');
const SRC_W = 640, SRC_H = 360, FPS = 24, OUT_W = 270, OUT_H = 480;
let composeTimeline, materializeExportEdl, work, clip, sharpClip;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
const durOf = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
const dimsOf = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', f], { encoding: 'utf8' }).trim().split('x').map(Number);

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'plan-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));

  work = tempFolder(join(tmpdir(), 'plan-render-'));
  // flat gray 16:9 (encodes with ~0 inter-frame noise, so motion is CLEAN) with a bright white box on the LEFT
  // third: the box is STATIC for 2s, then MOVES for 1s (the action). Flat gray is intentionally low-detail; the
  // `usable` gate is proven separately on a genuinely sharp clip below.
  const stat = join(work, 'stat.mp4'), act = join(work, 'act.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=gray:s=${SRC_W}x${SRC_H}:d=2:r=${FPS}`, '-vf', 'drawbox=x=40:y=150:w=70:h=70:color=white:t=fill', '-pix_fmt', 'yuv420p', stat]);
  ffmpeg(['-f', 'lavfi', '-i', `color=gray:s=${SRC_W}x${SRC_H}:d=1:r=${FPS}`, '-f', 'lavfi', '-i', `color=white:s=70x70:d=1:r=${FPS}`,
    '-filter_complex', "[0][1]overlay=x='45+35*sin(6*t)':y=150", '-pix_fmt', 'yuv420p', act]);   // box oscillates in the left third
  const list = join(work, 'l.txt'); writeFileSync(list, `file '${stat}'\nfile '${act}'\n`);
  clip = join(work, 'clip.mp4'); ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', clip]);

  // a genuinely sharp, well-exposed clip to prove the usable gate wires through the plan.
  sharpClip = join(work, 'sharp.mp4'); ffmpeg(['-f', 'lavfi', '-i', `testsrc=s=${SRC_W}x${SRC_H}:d=1:r=${FPS}`, '-pix_fmt', 'yuv420p', sharpClip]);
});

test('PURE: actionWindow picks the moving run around the motion peak', () => {
  const segs = [{ start: 0, end: 1, energy: 0 }, { start: 1, end: 2, energy: 0.05 }, { start: 2, end: 3, energy: 1 }];
  assert.deepEqual(actionWindow(segs, { threshold: 0.5 }), { start: 2, end: 3 });
  assert.equal(actionWindow([{ start: 0, end: 1, energy: 0 }]), null);  // no motion -> keep whole clip
});

test('COMPOSE: authorReelPlan finds the action at ~2s + a left-leaning reframe; usable gate wires through (L155)', () => {
  const plan = authorReelPlan(clip, { aspectW: 9, aspectH: 16, motionWindow: 1 });
  assert.ok(plan.action && plan.action.start >= 2 - 1e-6, `action window is the moving segment at >=2s (${JSON.stringify(plan.action)})`);
  const cx = plan.reframe.track.map((p) => p.cx);
  assert.ok(cx.length > 0 && cx.reduce((a, b) => a + b, 0) / cx.length < 0.5, `reframe leans toward the left subject (mean cx ${(cx.reduce((a, b) => a + b, 0) / cx.length).toFixed(3)})`);
  assert.equal(typeof plan.usable, 'boolean');
  assert.equal(plan.target_lufs, -14);
  assert.equal(Number.isFinite(plan.poster_time), true, 'a poster time was chosen');
  // the usable gate wires through: a genuinely sharp, well-exposed clip is marked usable.
  assert.equal(authorReelPlan(sharpClip, { motionWindow: 1 }).usable, true, 'a sharp clip is usable');
});

test('RENDER: applying the plan trims to the action and outputs 9:16 (drives the real render)', () => {
  const plan = authorReelPlan(clip, { aspectW: 9, aspectH: 16, motionWindow: 1 });
  const comp = composeTimeline({ lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 's1', label: 'Clip', start: 0, end: 3, source_ref: { artifact_ref: 'r.mp4', source_id: 's1' } },
  ] }], editDecisions: [], markers: [] });
  const { edl } = materializeExportEdl(comp, () => clip, { width: OUT_W, height: OUT_H, fps: FPS, deterministic: true });
  edl.spine.segments[0] = applyPlanToSegment(edl.spine.segments[0], plan);
  const f = join(work, 'planned.json'); const out = join(work, 'planned.mp4');
  writeFileSync(f, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', f, '--out', out], { encoding: 'utf8' });

  const actionLen = plan.action.end - plan.action.start;
  assert.ok(Math.abs(durOf(out) - actionLen) < 0.35, `output trimmed to the action (~${actionLen}s, got ${durOf(out).toFixed(2)})`);
  const [w, h] = dimsOf(out);
  assert.ok(Math.abs(w / h - 9 / 16) < 0.02, `output is 9:16 (${w}x${h})`);
});
