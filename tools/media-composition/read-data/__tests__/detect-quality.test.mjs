/**
 * #219 Clip-quality / take-selection PRODUCER (detect-quality.mjs): auto-pick the usable takes from a pile of
 * footage so the autonomous pipeline never assembles from blurry / badly-exposed clips. Measures SHARPNESS (mean
 * edge energy) and EXPOSURE (mean luma) per clip with ffmpeg; a pure scorer ranks them; the caller selects the
 * top N (ranking is DATA, selection reuses the existing clip choice, zero new render code, L069).
 *
 * Proof (L155, definitive same-content ground truth): the SAME source, sharp vs a boxblurred copy, differ only
 * in focus, so the sharp clip must score higher SHARPNESS (fabricated data could not make a blurred clip crisper).
 * A bright vs a dark clip differ only in EXPOSURE, so brightness orders correctly. The pure scorer peaks at the
 * target exposure and penalizes black/blown-out. rankTakes puts the sharp, well-exposed take first. PLUS
 * determinism.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureQuality, scoreQuality, rankTakes, pickBestTakes } from '../../do-work/detect-quality.mjs';

let work, sharp, blur, bright, dark;
function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }

before(() => {
  work = tempFolder(join(tmpdir(), 'quality-'));
  sharp = join(work, 'sharp.mp4'); ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', sharp]);
  blur = join(work, 'blur.mp4'); ffmpeg(['-i', sharp, '-vf', 'boxblur=8:2', '-pix_fmt', 'yuv420p', blur]);   // same content, softened
  bright = join(work, 'bright.mp4'); ffmpeg(['-f', 'lavfi', '-i', 'color=gray:s=320x240:d=2:r=24', '-vf', 'eq=brightness=0.4', '-pix_fmt', 'yuv420p', bright]);
  dark = join(work, 'dark.mp4'); ffmpeg(['-f', 'lavfi', '-i', 'color=gray:s=320x240:d=2:r=24', '-vf', 'eq=brightness=-0.4', '-pix_fmt', 'yuv420p', dark]);
});

test('SHARPNESS: a sharp clip out-scores a boxblurred copy of the SAME content (L155)', () => {
  const s = measureQuality(sharp), b = measureQuality(blur);
  assert.ok(s.sharpness > b.sharpness * 2, `sharp is much crisper (${s.sharpness} vs ${b.sharpness})`);
});

test('EXPOSURE: brightness orders a bright clip above a dark one', () => {
  const hi = measureQuality(bright), lo = measureQuality(dark);
  assert.ok(hi.brightness > 180 && lo.brightness < 60, `bright ${hi.brightness} vs dark ${lo.brightness}`);
});

test('pure scorer: peaks at the target exposure, penalizes black/blown-out, rewards sharpness', () => {
  // equal sharpness, exposure decides: mid > dark, mid > blown-out.
  assert.ok(scoreQuality({ sharpness: 5, brightness: 128 }) > scoreQuality({ sharpness: 5, brightness: 20 }));
  assert.ok(scoreQuality({ sharpness: 5, brightness: 128 }) > scoreQuality({ sharpness: 5, brightness: 245 }));
  // equal (good) exposure, sharpness decides.
  assert.ok(scoreQuality({ sharpness: 5, brightness: 128 }) > scoreQuality({ sharpness: 1, brightness: 128 }));
  // missing signals -> zero (never ranks an unmeasurable clip).
  assert.equal(scoreQuality({ sharpness: null, brightness: 128 }), 0);
});

test('rankTakes / pickBestTakes puts the sharp well-exposed take first, deterministically', () => {
  const ranked = pickBestTakes([blur, sharp]);
  assert.equal(ranked[0].file, sharp, 'sharp take ranked first');
  assert.equal(ranked[1].file, blur, 'blurred take ranked last');
  // pure-DATA rank is deterministic and independent of input order.
  const a = rankTakes([{ file: 'x', sharpness: 1, brightness: 128 }, { file: 'y', sharpness: 9, brightness: 128 }]);
  const b = rankTakes([{ file: 'y', sharpness: 9, brightness: 128 }, { file: 'x', sharpness: 1, brightness: 128 }]);
  assert.deepEqual(a, b);
  assert.equal(a[0].file, 'y');
});
