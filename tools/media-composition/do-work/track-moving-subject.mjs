/**
 * file: packages/media-composition/do-work/track-moving-subject.mjs
 *
 * PURPOSE: Follow whatever MOVES in a video (a player running across a court, a speaker gesturing) and emit its
 * normalized centre over time as the same track shape detect-track.mjs emits (`{ path: [{ t, x, y }] }`), so
 * auto-reframe's crop can follow a subject that is not the brightest thing in the picture. It is a PRODUCER: one
 * ffmpeg pass of small grey difference frames (`tblend=difference`), then the centre of ONE group of touching cells
 * that changed more than the frame's own noise: the group near the last centre while it keeps moving, else the group
 * with the most change. A frame where nothing moved keeps the last known centre.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. x and y are 0..1 of the picture (0 = left / top); t is seconds from the start of the video.
 * 2. Before anything has moved the centre is the middle of the picture; it is never invented from nothing later.
 * 3. The video is any address ffmpeg opens; nothing here reads a machine path.
 *
 * Usage: node track-moving-subject.mjs VIDEO [--step-ms 125] [--grid 64]
 * Output (stdout, JSON): { path: [{ t, x, y }], width, height, step_ms, grid }
 */
import { execFileSync, spawnSync } from 'node:child_process';

const round4 = value => Math.round(value * 10000) / 10000;

/** Share of the strongest group's change a group near the last centre needs to keep being followed. */
const KEEP_FOLLOWING = 0.35;
/** How near (0..1 of the picture) a group's centre must be to the last centre to count as the same subject. */
const SAME_SUBJECT = 0.15;

/**
 * The centre of ONE moving thing in one difference frame, or null when nothing rose above the frame's own noise.
 * Cells above the noise are joined into groups of touching cells; the group followed is the one near `last` when it
 * holds a fair share of the change (the same subject keeps being followed), else the group with the most change.
 * Averaging every group would put the centre in the empty space between two movers (a player and someone walking
 * past on another court), where the crop then shows neither.
 */
export function centreOfChange(frame, columns, rows, last = null) {
  let sum = 0;
  let squares = 0;
  for (const value of frame) { sum += value; squares += value * value; }
  const mean = sum / frame.length;
  const floor = mean + 2 * Math.sqrt(Math.max(0, squares / frame.length - mean * mean));
  const group = new Int32Array(frame.length).fill(-1);
  const groups = [];
  for (let start = 0; start < frame.length; start += 1) {
    if (group[start] !== -1 || frame[start] - floor <= 0) continue;
    const found = { weight: 0, x: 0, y: 0 };
    const stack = [start];
    group[start] = groups.length;
    while (stack.length) {
      const cell = stack.pop();
      const row = Math.floor(cell / columns);
      const column = cell % columns;
      const value = frame[cell] - floor;
      found.weight += value;
      found.x += value * (column + 0.5);
      found.y += value * (row + 0.5);
      // Touching includes one empty cell between, so a limb and a body split by the noise floor stay one subject.
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const r = row + dy;
          const c = column + dx;
          if (r < 0 || r >= rows || c < 0 || c >= columns) continue;
          const next = r * columns + c;
          if (group[next] !== -1 || frame[next] - floor <= 0) continue;
          group[next] = groups.length;
          stack.push(next);
        }
      }
    }
    groups.push({ weight: found.weight, x: found.x / found.weight / columns, y: found.y / found.weight / rows });
  }
  if (!groups.length) return null;
  const strongest = groups.reduce((best, item) => (item.weight > best.weight ? item : best));
  const same = last && groups
    .filter(item => item.weight >= KEEP_FOLLOWING * strongest.weight && Math.hypot(item.x - last.x, item.y - last.y) <= SAME_SUBJECT)
    .sort((left, right) => right.weight - left.weight)[0];
  const chosen = same ?? strongest;
  return { x: chosen.x, y: chosen.y };
}

export function trackMovingSubject(video, { stepMs = 125, grid = 64 } = {}) {
  const [width, height] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video], { encoding: 'utf8' }).trim().split(',').map(Number);
  if (!(width > 0 && height > 0)) throw new Error('The video has no picture ffprobe can read.');
  const columns = grid;
  const rows = Math.max(2, Math.round((grid * height) / width));
  const fps = 1000 / stepMs;
  const ran = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video, '-an',
    '-vf', `fps=${fps},scale=${columns}:${rows},format=gray,tblend=all_mode=difference`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  if (ran.status !== 0) throw new Error(`ffmpeg could not read the picture: ${String(ran.stderr).slice(-300)}`);
  const size = columns * rows;
  const path = [];
  let last = { x: 0.5, y: 0.5 };
  for (let at = 0; at + size <= ran.stdout.length; at += size) {
    last = centreOfChange(ran.stdout.subarray(at, at + size), columns, rows, path.length ? last : null) ?? last;
    path.push({ t: round4((path.length + 1) / fps), x: round4(last.x), y: round4(last.y) });
  }
  return { path, width, height, step_ms: stepMs, grid };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [video, ...rest] = process.argv.slice(2);
  const options = new Map();
  for (let at = 0; at < rest.length; at += 2) options.set(rest[at].replace(/^--/, ''), Number(rest[at + 1]));
  try {
    if (!video) throw new Error('usage: track-moving-subject.mjs VIDEO [--step-ms 125] [--grid 64]');
    process.stdout.write(`${JSON.stringify(trackMovingSubject(video, { stepMs: options.get('step-ms') ?? 125, grid: options.get('grid') ?? 64 }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
