/**
 * #221 Visual motion / action PRODUCER (detect-motion.mjs): the VISUAL twin of detect-highlights. Measures how
 * much the picture CHANGES per window (tblend difference -> signalstats YAVG) so the pipeline can find the ACTION
 * moment (swing / dunk / contact) in a long clip. It emits the SAME `{start,end,energy}` window shape as
 * detect-highlights, so the SHIPPED pure scorer (highlight-scorer.ts) ranks the windows and trims to the action
 * with zero new scoring/render code (L069).
 *
 * Proof (L155, definitive ground truth): a clip that is STATIC (a flat gray frame) for 2s then MOVING (testsrc)
 * for 1s. (1) detect-motion gives the static windows ~0 energy and the moving window 1.0 (a still frame cannot
 * fake motion). (2) INTEGRATION: feeding those windows to the shipped scoreHighlightWindows keeps the MOVING
 * window (start >= 2s) as the highlight, proving the visual producer drives the existing auto-shorts machinery.
 * An all-static clip yields all-zero energy.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureMotion } from '../../do-work/detect-motion.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const W = 240, H = 160, FPS = 24;
let work, clip, staticClip, scoreHighlightWindows;

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); }

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'motion-'));
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', '--alias:@=' + join(here, '..', '..', '..', '..'),
    join(here, '..', 'highlight-scorer.ts'), `--outfile=${join(dir, 'hs.mjs')}`], { encoding: 'utf8' });
  ({ scoreHighlightWindows } = await import(join(dir, 'hs.mjs')));

  work = tempFolder(join(tmpdir(), 'motion-render-'));
  const s = join(work, 's.mp4'), m = join(work, 'm.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=gray:s=${W}x${H}:d=2:r=${FPS}`, '-pix_fmt', 'yuv420p', s]);   // static 2s
  ffmpeg(['-f', 'lavfi', '-i', `testsrc=s=${W}x${H}:d=1:r=${FPS}`, '-pix_fmt', 'yuv420p', m]);        // moving 1s
  const list = join(work, 'list.txt'); writeFileSync(list, `file '${s}'\nfile '${m}'\n`);
  clip = join(work, 'clip.mp4'); ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', clip]);
  staticClip = join(work, 'static.mp4'); ffmpeg(['-f', 'lavfi', '-i', `color=gray:s=${W}x${H}:d=3:r=${FPS}`, '-pix_fmt', 'yuv420p', staticClip]);
});

test('motion energy peaks in the MOVING window and is ~0 in the static windows (L155)', () => {
  const { segments, duration } = measureMotion(clip, { windowSeconds: 1 });
  assert.ok(Math.abs(duration - 3) < 0.2, `~3s clip (${duration})`);
  assert.equal(segments.length, 3);
  assert.ok(segments[0].energy < 0.1 && segments[1].energy < 0.1, `static windows are quiet (${segments[0].energy}, ${segments[1].energy})`);
  assert.ok(segments[2].energy > 0.8, `moving window is the peak (${segments[2].energy})`);
});

test('INTEGRATION: the shipped scorer keeps the MOVING window as the highlight (auto-shorts reuse)', () => {
  const { segments } = measureMotion(clip, { windowSeconds: 1 });
  const kept = scoreHighlightWindows(segments, { count: 1 });
  assert.equal(kept.length, 1, 'one highlight window kept');
  assert.ok(kept[0].start >= 2 - 1e-6, `highlight is the action segment at >=2s (start ${kept[0].start})`);
});

test('an all-static clip yields all-zero motion energy (no false action)', () => {
  const { segments } = measureMotion(staticClip, { windowSeconds: 1 });
  assert.ok(segments.every((s) => s.energy === 0), 'no motion on a still clip');
});
