/**
 * file: packages/media-composition/do-work/change-speed-over-a-range.mjs
 *
 * PURPOSE: Play one stretch of a video at another speed (slow motion around a moment, a sped-up walk) while the rest
 * plays normally, and optionally keep only a window of the video around it. It only AUTHORS the edit: up to three
 * `clip` segments of the same source, the middle one carrying the clip `speed` video-compose already applies to picture
 * (setpts) and sound (atempo), rendered by render-an-edit.mjs. Sound keeps playing through the changed stretch.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Times are source seconds. The changed stretch must lie inside the kept window, and the kept window inside the video.
 * 2. The expected length is computed from the edit and returned beside the measured one, so a caller can check them.
 * 3. The video is any address ffmpeg opens; nothing here reads a machine path.
 *
 * Usage: node change-speed-over-a-range.mjs --video VIDEO --from S --to S --speed X --output FILE
 *          [--keep-from S] [--keep-to S]
 * Output (stdout, JSON): { expected_duration_seconds, duration_seconds, width, height, has_audio, bytes, segments }
 */
import { execFileSync } from 'node:child_process';
import { renderEdl } from './render-an-edit.mjs';

const round3 = value => Math.round(value * 1000) / 1000;
// A piece shorter than this is left out rather than rendered as a flash of a frame or two.
const SHORTEST_PIECE = 0.05;

/** The edit: the kept window cut into before / changed / after pieces. Returns { edl, expected_duration_seconds }. */
export function speedRangeEdl({ video, from, to, speed, keepFrom, keepTo }) {
  if (!(Number.isFinite(speed) && speed >= 0.1 && speed <= 10)) throw new Error(`The speed must be between 0.1 and 10; it was ${speed}.`);
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) throw new Error(`The stretch must end after it starts; it was ${from} to ${to}.`);
  if (!(keepFrom <= from && to <= keepTo)) throw new Error(`The stretch ${from} to ${to} must lie inside the kept window ${keepFrom} to ${keepTo}.`);
  const pieces = [
    { id: 'before', in: keepFrom, out: from, speed: 1 },
    { id: 'changed', in: from, out: to, speed },
    { id: 'after', in: to, out: keepTo, speed: 1 },
  ].filter(piece => piece.out - piece.in >= SHORTEST_PIECE);
  return {
    edl: { spine: { segments: pieces.map(piece => ({ kind: 'clip', id: piece.id, source: video, in: round3(piece.in), out: round3(piece.out), ...(piece.speed === 1 ? {} : { speed: piece.speed }) })) } },
    expected_duration_seconds: round3(pieces.reduce((sum, piece) => sum + (piece.out - piece.in) / piece.speed, 0)),
  };
}

const durationOf = video => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' }).trim());

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at].replace(/^--/, ''), process.argv[at + 1]);
  try {
    const video = args.get('video');
    const output = args.get('output');
    if (!video || !output) throw new Error('usage: change-speed-over-a-range.mjs --video VIDEO --from S --to S --speed X --output FILE [--keep-from S] [--keep-to S]');
    const duration = durationOf(video);
    if (!(duration > 0)) throw new Error('The video has no length ffprobe can read.');
    const number = (name, otherwise) => (args.has(name) && args.get(name) !== '' ? Number(args.get(name)) : otherwise);
    const keepFrom = Math.max(0, number('keep-from', 0));
    const keepTo = Math.min(duration, number('keep-to', duration));
    const { edl, expected_duration_seconds } = speedRangeEdl({ video, from: number('from'), to: number('to'), speed: number('speed'), keepFrom, keepTo });
    process.stdout.write(`${JSON.stringify({ expected_duration_seconds, ...renderEdl(edl, output) })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
