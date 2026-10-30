/**
 * file: packages/media-composition/do-work/reframe-to-a-size.mjs
 *
 * PURPOSE: Make a video fit another shape (a vertical 9:16 reel from a wide 16:9 recording, a square post) with the
 * crop window FOLLOWING the subject. It only composes owners: auto-reframe.mjs tracks the subject and returns the
 * `reframe` DATA, one `clip` segment carries it, and render-an-edit.mjs renders it (video-compose's animated crop).
 * What the crop follows is chosen by `--follow`: `motion` (default, track-moving-subject.mjs: whatever moves) or
 * `brightness` (detect-track.mjs through auto-reframe: the brightest region). Both emit the same track shape, and
 * auto-reframe's planCamera turns it into a camera that holds still while the subject stays in frame and pans smoothly
 * only when it leaves.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. The whole video is kept; only its frame changes. Its length is unchanged and returned beside the measured one.
 * 2. `--fill crop` (default) fills the new frame by cropping; `blur` fits the whole picture over a blurred copy of
 *    itself; any other value is a solid colour behind the fitted picture (video-compose's fill_mode DATA).
 * 3. The output frame is exactly --width x --height when given; otherwise it is the largest window of the new shape
 *    that fits inside the source picture (no upscaling), rounded to even pixels.
 * 4. The video is any address ffmpeg opens; nothing here reads a machine path.
 *
 * Usage: node reframe-to-a-size.mjs --video VIDEO --output FILE [--aspect-w 9] [--aspect-h 16] [--fill crop|blur|COLOR]
 *          [--width PX --height PX] [--follow motion|brightness]
 * Output (stdout, JSON): { expected_duration_seconds, duration_seconds, width, height, has_audio, bytes, segments }
 */
import { execFileSync } from 'node:child_process';
import { autoReframe, trackToReframe } from './auto-reframe.mjs';
import { trackMovingSubject } from './track-moving-subject.mjs';
import { renderEdl } from './render-an-edit.mjs';

const even = value => Math.max(2, 2 * Math.round(value / 2));
/** The output frame: the caller's exact size, or the largest window of the new shape inside the source picture. */
export function frameSize({ aspectW, aspectH, source, width, height }) {
  if (Number.isFinite(width) && Number.isFinite(height)) {
    if (!(width > 0 && height > 0)) throw new Error('The output width and height must be positive.');
    return { width: even(width), height: even(height) };
  }
  const fitsByHeight = source.height * aspectW / aspectH <= source.width;
  return fitsByHeight
    ? { width: even(source.height * aspectW / aspectH), height: even(source.height) }
    : { width: even(source.width), height: even(source.width * aspectH / aspectW) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at].replace(/^--/, ''), process.argv[at + 1]);
  try {
    const video = args.get('video');
    const output = args.get('output');
    if (!video || !output) throw new Error('usage: reframe-to-a-size.mjs --video VIDEO --output FILE [--aspect-w 9] [--aspect-h 16] [--fill crop|blur|COLOR] [--width PX --height PX] [--follow motion|brightness]');
    const aspectW = Number(args.get('aspect-w') ?? 9);
    const aspectH = Number(args.get('aspect-h') ?? 16);
    if (!(aspectW > 0 && aspectH > 0)) throw new Error('The new shape needs a positive width and height, for example 9 and 16.');
    const probed = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', video], { encoding: 'utf8' }));
    const duration = Number(probed.format?.duration);
    const source = probed.streams?.[0] ?? {};
    if (!(duration > 0 && source.width > 0 && source.height > 0)) throw new Error('The video has no picture and length ffprobe can read.');
    // An empty --width or --height (the Workshop row's default) means "not given".
    const given = name => (args.get(name) ? Number(args.get(name)) : NaN);
    const size = frameSize({ aspectW, aspectH, source, width: given('width'), height: given('height') });
    const fill = args.get('fill') ?? 'crop';
    const shape = { aspectW, aspectH, ...(fill === 'crop' ? {} : { fillMode: fill }) };
    const followers = { motion: () => trackToReframe(trackMovingSubject(video).path, { ...shape, source }), brightness: () => autoReframe(video, shape) };
    const follow = followers[args.get('follow') ?? 'motion'];
    if (!follow) throw new Error(`--follow is one of ${Object.keys(followers).join(', ')}.`);
    const reframe = follow();
    const edl = { encode: size, spine: { segments: [{ kind: 'clip', id: 'reframed', source: video, reframe }] } };
    process.stdout.write(`${JSON.stringify({ expected_duration_seconds: Math.round(duration * 1000) / 1000, ...renderEdl(edl, output) })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
