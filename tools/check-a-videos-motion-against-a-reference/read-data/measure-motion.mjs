// How much a video moves, measured with ffmpeg and ffprobe only. Every frame is decoded as a small grey picture, and the mean
// absolute difference in grey between each frame and the one before it says how much the picture changed.
//   - a change above the cut level is a cut, not movement;
//   - a change above the still level (and not a cut) is movement. The still level is the amount below which nothing visibly
//     changed: grain and compression raise it, so it is read from the video's own quietest tenth of changes, within a floor and
//     a ceiling. A piece is measured at the reference's still level so both are held to the same eye;
//   - a frame counts as moving when it or either neighbour changed, so animation drawn on twos or threes still counts;
//   - a hold is a run of frames that are neither moving nor a cut, timed by the frame rate.
// The settings of the measure are DATA in motion-measure.json. This module measures; it knows no bar.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const settings = JSON.parse(readFileSync(new URL('./motion-measure.json', import.meta.url), 'utf8'));
const MAX_BUFFER = 1 << 30;
const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

/** { width, height, fps, duration } of a video's first picture stream, by ffprobe. */
export function probe(path) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,r_frame_rate:format=duration', '-of', 'json', path]).toString();
  const { streams, format } = JSON.parse(out);
  if (!streams?.length) throw new Error(`${path} has no picture to measure. Give a video file.`);
  const [top, bottom] = streams[0].r_frame_rate.split('/').map(Number);
  return { width: streams[0].width, height: streams[0].height, fps: top / (bottom || 1), duration: Number(format.duration) };
}

/** Mean absolute grey change between each frame and the one before it, for the first `seconds` of the video (all of it when 0). */
export function frameChanges(path, seconds, info) {
  const width = settings.frame_width;
  const height = Math.max(2, Math.round((info.height * width) / info.width / 2) * 2);
  const raw = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', path, '-t', String(seconds),
    '-vf', `scale=${width}:${height},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: MAX_BUFFER });
  const size = width * height;
  const frames = Math.floor(raw.length / size);
  const changes = [];
  for (let frame = 1; frame < frames; frame++) {
    let sum = 0;
    const now = frame * size;
    const before = now - size;
    for (let i = 0; i < size; i++) sum += Math.abs(raw[now + i] - raw[before + i]);
    changes.push(sum / size);
  }
  return changes;
}

/** The still level read from a video's own changes. */
export function stillLevelOf(changes) {
  const { from_percentile: percentile, times, floor, ceiling } = settings.still_level;
  const quiet = [...changes].sort((x, y) => x - y)[Math.floor(changes.length * percentile)] ?? 0;
  return Math.min(ceiling, Math.max(floor, times * quiet));
}

/**
 * { seconds, moving_share, longest_hold_s, holds_over_1s_per_min, still_threshold } for the first `seconds` of a video
 * (all of it when 0). `still` is the still level to hold it to (a reference's); left out, it is read from this video.
 */
export function measureMotion(path, seconds = 0, still = null) {
  const info = probe(path);
  const length = seconds || info.duration;
  const changes = frameChanges(path, length, info);
  const level = still ?? stillLevelOf(changes);
  const cut = settings.cut_level;
  const moves = value => value > level && value <= cut;
  const moving = changes.map((_, i) => [changes[i - 1], changes[i], changes[i + 1]].some(value => value !== undefined && moves(value)));
  const holds = [];
  let run = 0;
  for (let i = 0; i <= moving.length; i++) {
    if (i < moving.length && !moving[i] && changes[i] <= cut) run++;
    else {
      if (run) holds.push(run / info.fps);
      run = 0;
    }
  }
  return {
    seconds: round(length, 2),
    moving_share: round(moving.filter(Boolean).length / Math.max(1, changes.length), 2),
    longest_hold_s: round(Math.max(0, ...holds), 2),
    holds_over_1s_per_min: round((holds.filter(hold => hold >= 1).length / length) * 60, 1),
    still_threshold: round(level, 2),
  };
}
