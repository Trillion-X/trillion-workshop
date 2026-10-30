// tools/media-composition/do-work/detect-scenes.mjs
/**
 * #97 Scene-detect producer. Runs ffmpeg scene-change detection over a source video and emits the
 * cut timestamps (seconds) as DATA. It is a PRODUCER: it WRITES split-decision DATA (the cut times);
 * the compositor stays blind. The caller turns each cut into a `split` edit-decision (the same fold
 * op the timeline already uses), so a long recording auto-segments into shot clips with zero new
 * render code (L069). The scene threshold (0..1, higher = fewer/harder cuts) is DATA.
 *
 * Usage: node detect-scenes.mjs <video-path> [threshold=0.3]
 * Output (stdout, JSON): { cuts: [<seconds>, ...], threshold, count }
 */
import { spawnSync } from 'node:child_process';

const videoPath = process.argv[2];
const threshold = Number.isFinite(Number(process.argv[3])) ? Number(process.argv[3]) : 0.3;
if (!videoPath) {
  process.stderr.write('[detect-scenes] usage: node detect-scenes.mjs <video-path> [threshold]\n');
  process.exit(2);
}

// `select='gt(scene,thr)'` passes ONLY the frames where the scene-change score exceeds the threshold;
// `metadata=print` emits a `pts_time:<seconds>` line for each (on stderr). Parse into cut timestamps.
const res = spawnSync('ffmpeg', [
  '-hide_banner', '-i', videoPath,
  '-filter:v', `select='gt(scene,${threshold})',metadata=print`,
  '-an', '-f', 'null', '-',
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;

const cuts = [];
for (const m of out.matchAll(/pts_time:([0-9]+\.?[0-9]*)/g)) {
  const t = Number(m[1]);
  // the very first frame (t≈0) is always "a scene change"; drop it, keep interior cuts only.
  if (Number.isFinite(t) && t > 0.05) cuts.push(Number(t.toFixed(3)));
}
// dedupe near-identical timestamps (within a frame)
const deduped = cuts.filter((t, i) => i === 0 || Math.abs(t - cuts[i - 1]) > 0.04);

process.stdout.write(`${JSON.stringify({ cuts: deduped, threshold, count: deduped.length })}\n`);
