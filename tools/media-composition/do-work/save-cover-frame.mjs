/**
 * file: packages/media-composition/do-work/save-cover-frame.mjs
 *
 * PURPOSE: Choose the best frame of a video for its cover (thumbnail) and save it as a picture. The choice is
 * pick-poster-frame.mjs's (sharpness and exposure, the same scoring take selection uses); this only cuts that frame
 * out with ffmpeg, or the frame at `--at` when the caller already knows the moment.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. The saved frame's time is returned, and it lies inside the video.
 * 2. The video is any address ffmpeg opens; nothing here reads a machine path.
 *
 * Usage: node save-cover-frame.mjs --video VIDEO --output FILE.jpg [--at S] [--width PX] [--step S]
 * Output (stdout, JSON): { time, chosen_by, score, width, height, bytes }
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { bestPosterTime } from './pick-poster-frame.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at].replace(/^--/, ''), process.argv[at + 1]);
  try {
    const video = args.get('video');
    const output = args.get('output');
    if (!video || !output) throw new Error('usage: save-cover-frame.mjs --video VIDEO --output FILE.jpg [--at S] [--width PX] [--step S]');
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' }).trim());
    const knownDuration = Number.isFinite(duration) && duration > 0;
    const given = args.has('at') && args.get('at') !== '' ? Number(args.get('at')) : null;
    if (given !== null && !(Number.isFinite(given) && given >= 0 && (!knownDuration || given < duration))) {
      throw new Error(knownDuration ? `--at must be inside the video (0 to ${duration} seconds); it was ${args.get('at')}.`
        : `--at must be a nonnegative number; it was ${args.get('at')}.`);
    }
    const picked = given === null ? bestPosterTime(video, args.has('step') ? { step: Number(args.get('step')) } : {}) : null;
    const time = given ?? picked.t;
    const width = Number(args.get('width') ?? 0);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(time), '-i', video, '-frames:v', '1', '-q:v', '2',
      ...(width > 0 ? ['-vf', `scale=${Math.round(width / 2) * 2}:-2`] : []), output]);
    const bytes = statSync(output).size;
    if (!bytes) throw new Error('No video frame could be read at the chosen time.');
    const [frameWidth, frameHeight] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', output], { encoding: 'utf8' }).trim().split(',').map(Number);
    process.stdout.write(`${JSON.stringify({ time, chosen_by: given === null ? 'sharpness and exposure' : 'the time given', score: picked?.score ?? null, width: frameWidth, height: frameHeight, bytes })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
