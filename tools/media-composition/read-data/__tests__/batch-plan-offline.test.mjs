/**
 * #233 Intelligent batch (batch-produce-reels --plan): the "1 million videos, no review" scale path. The batch
 * orchestrator rendered DUMB reels (fixed in:0/out:SECONDS window, cycled look, fixed poster). With --plan it now
 * runs the authorReelPlan capstone (#225 + #230/#231/#232) per clip and applies it, so each reel is action-trimmed,
 * reframed, loudness-normalized, and poster'd at the best frame. Composition only (L069): the plan is DATA applied
 * to the same comp the render already consumes; the batch owns no intelligence (anti-primitive-without-product at
 * batch scale).
 *
 * Proof (L155, definitive offline render): one clip that is STATIC for 2s then has MOTION in [2,3]. The dumb batch
 * renders the whole clip (~3s); the --plan batch trims to the action window (~1s). Comparing the two rendered
 * reels' durations proves the capstone's action-trim actually drove the batch render, end to end.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BATCH = new URL('../../do-work/batch-produce-reels.mjs', import.meta.url).pathname;
let work, clip, manifest;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }
function durationOf(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
}
function runBatch(outDir, extra) {
  const result = join(outDir, 'batch.json');
  execFileSync('node', [BATCH, '--manifest', manifest, '--count', '1', '--looks', 'vhs', '--out-dir', outDir,
    '--width', '480', '--height', '270', '--fps', '24', '--seconds', '5', ...extra, '--result', result], { encoding: 'utf8' });
  return JSON.parse(readFileSync(result, 'utf8'));
}

before(() => {
  work = tempFolder(join(tmpdir(), 'batchplan-'));
  clip = join(work, 'clip.mp4');
  // static black for [0,2] (no motion) concatenated with high-motion testsrc2 for [2,3] (the action window),
  // both with a real tone for the plan's loudnorm. detect-motion then reports the action in [2,3].
  const a = join(work, 'a.mp4'), b = join(work, 'b.mp4'), list = join(work, 'list.txt');
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=480x270:d=2:r=24', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', a]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=480x270:d=1:r=24', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', b]);
  writeFileSync(list, `file '${a}'\nfile '${b}'\n`);
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', clip]);
  manifest = join(work, 'clips.tsv');
  writeFileSync(manifest, `${clip}\tAction Clip\n`);
});

test('DUMB batch renders the fixed window; --plan batch trims to the action window (L155)', () => {
  const dumb = runBatch(join(work, 'dumb'), []);
  const planned = runBatch(join(work, 'plan'), ['--plan', '1']);
  assert.equal(dumb.length, 1, 'dumb batch produced one reel');
  assert.equal(planned.length, 1, 'plan batch produced one reel');

  const dumbDur = durationOf(dumb[0].video_path);
  const planDur = durationOf(planned[0].video_path);
  assert.ok(dumbDur > 2.5, `dumb reel is the whole ~3s clip (${dumbDur.toFixed(2)}s)`);
  assert.ok(planDur < 2.0, `planned reel is trimmed to the ~1s action window (${planDur.toFixed(2)}s)`);
  assert.ok(dumbDur - planDur > 1.2, `the capstone action-trim drove the batch render (${dumbDur.toFixed(2)}s -> ${planDur.toFixed(2)}s)`);
});
