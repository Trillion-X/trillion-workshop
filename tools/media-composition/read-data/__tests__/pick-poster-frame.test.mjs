/**
 * #224 Poster / thumbnail best-frame PRODUCER (pick-poster-frame.mjs): choose the timestamp of the sharpest,
 * best-exposed frame to hand to extract-poster, so an auto-generated reel's thumbnail is crisp instead of a
 * blind fixed timestamp. Reuses detect-quality's `scoreQuality` (SSOT: one quality scorer for take-selection AND
 * the poster). PRODUCER only: it returns a timestamp (DATA); the frame is cut by the existing extract-poster, so
 * zero new render code (L069).
 *
 * Proof (L155, definitive ground truth): a clip whose first 2s are blurry AND dark, then 1s is sharp AND
 * well-exposed. bestPosterTime must land in the sharp-bright window (t >= 2), since a blurry dark frame cannot
 * out-score a crisp well-exposed one. scoreFrames orders the windows accordingly, and the pick is deterministic.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreFrames, bestPosterTime } from '../../do-work/pick-poster-frame.mjs';

const W = 320, H = 240, FPS = 24;
let work, clip;
function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }

before(() => {
  work = tempFolder(join(tmpdir(), 'poster-'));
  const bad = join(work, 'bad.mp4'), good = join(work, 'good.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=gray:s=${W}x${H}:d=2:r=${FPS}`, '-vf', 'eq=brightness=-0.3,boxblur=6:2', '-pix_fmt', 'yuv420p', bad]); // 2s blurry + dark
  ffmpeg(['-f', 'lavfi', '-i', `testsrc=s=${W}x${H}:d=1:r=${FPS}`, '-pix_fmt', 'yuv420p', good]);                                          // 1s sharp + exposed
  const list = join(work, 'l.txt'); writeFileSync(list, `file '${bad}'\nfile '${good}'\n`);
  clip = join(work, 'clip.mp4'); ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', clip]);
});

test('bestPosterTime lands on the sharp, well-exposed window (not the blurry dark one) (L155)', () => {
  const best = bestPosterTime(clip, { step: 0.5 });
  assert.ok(best.t >= 2 - 1e-6, `poster frame is in the good window at t>=2 (${best.t})`);
  assert.ok(best.sharpness > 1 && best.brightness > 90, `chosen frame is crisp + well-exposed (sharp ${best.sharpness}, bright ${best.brightness})`);
});

test('scoreFrames scores the good window far above the blurry dark window', () => {
  const frames = scoreFrames(clip, { step: 0.5 });
  const goodMax = Math.max(...frames.filter((f) => f.t >= 2).map((f) => f.score));
  const badMax = Math.max(...frames.filter((f) => f.t < 2).map((f) => f.score));
  assert.ok(goodMax > badMax * 3, `good window out-scores the bad window (${goodMax.toFixed(2)} vs ${badMax.toFixed(2)})`);
});

test('the pick is deterministic', () => {
  assert.deepEqual(bestPosterTime(clip, { step: 0.5 }), bestPosterTime(clip, { step: 0.5 }));
});
