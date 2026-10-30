/**
 * file: tools/media-composition/do-work/auto-reframe.mjs
 *
 * PURPOSE: #220 Auto-reframe PRODUCER (horizontal -> vertical for reels, the Opus-Clip / Descript feature). Retarget a
 * 16:9 shot to 9:16 (or any aspect) with a crop window that FOLLOWS the subject, so hundreds of vertical reels a day come
 * off horizontal footage without a human keyframing the crop. It is the BRIDGE between the subject trackers
 * (detect-track: brightest region; track-moving-subject: what moves; any detector emitting `{t,x,y}`) and the `reframe`
 * render (video-compose: animated cover-crop from `{aspect_w,aspect_h,track:[{t,cx,cy}]}`). ZERO new render code (L069).
 *
 * THE CAMERA (planCamera). A tracker's path is a noisy point: a person doing sit-ups, a speaker gesturing, two movers
 * trading places all make it swing several times a second. Following that point is what made a reframed sit-ups video
 * swing left-right-left-right without rest. A camera operator does the opposite: holds the shot while the subject stays
 * well inside it, and pans only when the subject leaves, smoothly, at a bounded speed. planCamera is that operator, per
 * axis: (1) a running median outvotes single noisy readings; (2) the whole path fits inside the hold zone -> one still
 * crop for the whole shot (two keyframes); else (3) a dead zone moves the aim only by how far the subject pushes past
 * the zone's edge; (4) the camera chases the aim no faster than `max_speed`, and cuts to it when the subject has got
 * further ahead than `cut_beyond` (a pan across the picture reads as a swing, a cut as an edit); (5) a forward-and-back
 * ease rounds every start and stop within each run between cuts; (6) the path is simplified so a hold is two keyframes and a pan a few; (7) each move that does happen carries the
 * motion blur a shutter would leave on it (planMotionBlur), which the compositor draws only while the camera moves. Every number is DATA
 * (read-data/reframe-camera.json); a caller may lay its own over it (`camera`).
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. cx/cy are 0..1 of the source picture and always keep the crop window inside it (a centre in [w/2, 1-w/2]).
 * 2. The crop window's share of the picture comes from the source's real size; without it the plan refuses (it never
 *    guesses a size).
 * 3. An axis the window spans whole (the height of a 16:9 -> 9:16 crop) is a still 0.5.
 * 4. Same input, same output: pure functions, no clock, no randomness.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import CAMERA from '../read-data/reframe-camera.json' with { type: 'json' };

const HERE = dirname(fileURLToPath(import.meta.url));
const round4 = (n) => Math.round(n * 10000) / 10000;
const clamp = (x, low, high) => (x < low ? low : x > high ? high : x);
// How long before a cut the old framing is last held: one frame of even fast video, so the cut is a cut.
const CUT_SECONDS = 0.001;

/** The share of the source picture the crop window spans on each axis, from the source size and the target shape. */
export function windowShare({ aspectW, aspectH, source }) {
  if (!(source?.width > 0 && source?.height > 0)) throw new Error('The reframe needs the source picture size (width and height).');
  if (!(aspectW > 0 && aspectH > 0)) throw new Error('The new shape needs a positive width and height, for example 9 and 16.');
  const target = aspectW / aspectH;
  const picture = source.width / source.height;
  return { w: Math.min(1, target / picture), h: Math.min(1, picture / target) };
}

// The middle value of the readings within `half` seconds either side of each reading.
function runningMedian(times, values, half) {
  const out = new Array(values.length);
  let from = 0;
  let to = 0;
  for (let index = 0; index < values.length; index += 1) {
    while (times[from] < times[index] - half) from += 1;
    while (to + 1 < values.length && times[to + 1] <= times[index] + half) to += 1;
    const window = values.slice(from, to + 1).sort((a, b) => a - b);
    const middle = window.length >> 1;
    out[index] = window.length % 2 ? window[middle] : (window[middle - 1] + window[middle]) / 2;
  }
  return out;
}

const quantile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))];

// One forward pass of an exponential ease over uneven times, `tau` seconds.
function easePass(times, values, tau, order) {
  const out = values.slice();
  for (let step = 1; step < order.length; step += 1) {
    const here = order[step];
    const before = order[step - 1];
    const k = 1 - Math.exp(-Math.abs(times[here] - times[before]) / tau);
    out[here] = out[before] + k * (values[here] - out[before]);
  }
  return out;
}

// Keeps the fewest knots whose straight lines stay within `tolerance` of every planned value (Ramer-Douglas-Peucker on
// the value axis).
function simplify(times, values, tolerance) {
  const keep = new Uint8Array(values.length);
  keep[0] = 1;
  keep[values.length - 1] = 1;
  const stack = [[0, values.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let worst = -1;
    let gap = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const share = (times[index] - times[first]) / ((times[last] - times[first]) || 1);
      const line = values[first] + share * (values[last] - values[first]);
      const off = Math.abs(values[index] - line);
      if (off > gap) { gap = off; worst = index; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([first, worst], [worst, last]); }
  }
  return [...keep.keys()].filter((index) => keep[index]);
}

/**
 * Plans one axis of the camera: `times` (seconds, increasing) and `values` (the subject's 0..1 position) to the crop
 * centre over time, as knots `[{t, v}]`. `share` is the crop window's share of the picture on this axis.
 */
export function planAxis(times, values, share, settings = CAMERA) {
  const low = share / 2;
  const high = 1 - share / 2;
  if (!times.length) return [];
  if (high - low < 1e-6) return [{ t: times[0], v: 0.5 }, { t: times[times.length - 1], v: 0.5 }];
  const steady = runningMedian(times, values, settings.steady_seconds / 2);
  const zone = (settings.hold_zone * share) / 2;
  const sorted = steady.slice().sort((a, b) => a - b);
  const spread = [quantile(sorted, 0.05), quantile(sorted, 0.95)];
  // The whole shot fits inside the hold zone: one still crop, aimed at the middle of where the subject goes.
  if (spread[1] - spread[0] <= 2 * zone) {
    const still = round4(clamp((spread[0] + spread[1]) / 2, low, high));
    return [{ t: times[0], v: still }, { t: times[times.length - 1], v: still }];
  }
  // The aim moves only by how far the subject pushes past the edge of the hold zone.
  const aim = new Array(steady.length);
  let at = clamp(steady[0], low, high);
  for (let index = 0; index < steady.length; index += 1) {
    const past = steady[index] - at;
    if (Math.abs(past) > zone) at = clamp(at + past - Math.sign(past) * zone, low, high);
    aim[index] = at;
  }
  // The camera chases the aim no faster than max_speed (window widths per second). When the subject has got further
  // ahead of the camera than cut_beyond window widths, a pan would chase it across the picture: the camera cuts to it.
  const fastest = settings.max_speed * share;
  const cutBeyond = settings.cut_beyond * share;
  const camera = new Array(aim.length);
  const cuts = [];
  camera[0] = aim[0];
  for (let index = 1; index < aim.length; index += 1) {
    const behind = aim[index] - camera[index - 1];
    if (Math.abs(behind) > cutBeyond) { camera[index] = aim[index]; cuts.push(index); continue; }
    const room = fastest * (times[index] - times[index - 1]);
    camera[index] = camera[index - 1] + clamp(behind, -room, room);
  }
  // Each run between cuts eases forward then back: every start and stop is gentle, with no lag left behind, and a
  // cut stays a cut (the last frame before it holds the old framing).
  const knots = [];
  const bounds = [0, ...cuts, camera.length];
  for (let run = 0; run + 1 < bounds.length; run += 1) {
    const span = [...Array(bounds[run + 1] - bounds[run]).keys()].map((offset) => bounds[run] + offset);
    const runTimes = span.map((index) => times[index]);
    const order = [...span.keys()];
    const eased = easePass(runTimes, easePass(runTimes, span.map((index) => camera[index]), settings.ease_seconds, order), settings.ease_seconds, order.slice().reverse())
      .map((value) => clamp(value, low, high));
    const kept = span.length > 1 ? simplify(runTimes, eased, settings.keep_within) : [0];
    if (run > 0) knots.push({ t: round4(runTimes[0] - CUT_SECONDS), v: knots[knots.length - 1].v });
    for (const at of kept) knots.push({ t: runTimes[at], v: round4(eased[at]) });
  }
  return knots;
}

// The value of piecewise-linear knots at time `t`.
function valueAt(knots, t) {
  if (t <= knots[0].t) return knots[0].v;
  for (let index = 1; index < knots.length; index += 1) {
    if (t <= knots[index].t) {
      const before = knots[index - 1];
      const after = knots[index];
      return before.v + ((t - before.t) / ((after.t - before.t) || 1)) * (after.v - before.v);
    }
  }
  return knots[knots.length - 1].v;
}

/**
 * Pure: a subject path `[{t,x,y}]` to the camera's crop centre over time `[{t,cx,cy}]`, for a crop window of
 * `aspectW:aspectH` inside a `source` picture of `{width,height}`. `camera` lays the caller's own settings over
 * read-data/reframe-camera.json.
 */
export function planCamera(path, { aspectW = 9, aspectH = 16, source, camera = {} } = {}) {
  const share = windowShare({ aspectW, aspectH, source });
  const settings = { ...CAMERA, ...camera };
  const points = (Array.isArray(path) ? path : [])
    .filter((p) => p && Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t)
    .filter((p, index, all) => index === 0 || p.t > all[index - 1].t);
  if (!points.length) return [];
  const times = points.map((p) => p.t);
  const axis = (key, part) => planAxis(times, points.map((p) => clamp(Number.isFinite(p[key]) ? p[key] : 0.5, 0, 1)), part, settings);
  const xs = axis('x', share.w);
  const ys = axis('y', share.h);
  const knotTimes = [...new Set([...xs, ...ys].map((knot) => knot.t))].sort((a, b) => a - b);
  return knotTimes.map((t) => ({ t: round4(t), cx: round4(valueAt(xs, t)), cy: round4(valueAt(ys, t)) }));
}

/**
 * Pure: the motion blur a real camera's shutter leaves on each move of a planned `track`. While the crop window pans,
 * every frame is exposed for `shutter_seconds`, so the picture smears by how far the window travels in that time. Each
 * span between two knots where the camera moves gets `{from, to, streak_x, streak_y}`: the smear as a share of the
 * crop window's width and height. A smear under `least_streak` is not seen and is left out; a cut (two knots closer
 * than a frame) is a cut, never a smear. Neighbouring spans with the same smear (to `streak_step`) are one span.
 */
export function planMotionBlur(track, { aspectW = 9, aspectH = 16, source, camera = {} } = {}) {
  const share = windowShare({ aspectW, aspectH, source });
  const settings = { ...CAMERA, ...camera };
  const step = settings.streak_step;
  const spans = [];
  for (let index = 1; index < (track?.length ?? 0); index += 1) {
    const before = track[index - 1];
    const after = track[index];
    const seconds = after.t - before.t;
    if (!(seconds > CUT_SECONDS * 2)) continue;
    const smear = (move, part) => Math.round(((Math.abs(move) / seconds) * settings.shutter_seconds) / part / step) * step;
    const streak = { streak_x: round4(smear(after.cx - before.cx, share.w)), streak_y: round4(smear(after.cy - before.cy, share.h)) };
    if (Math.max(streak.streak_x, streak.streak_y) < settings.least_streak) continue;
    const last = spans[spans.length - 1];
    if (last && last.to === before.t && last.streak_x === streak.streak_x && last.streak_y === streak.streak_y) last.to = after.t;
    else spans.push({ from: before.t, to: after.t, ...streak });
  }
  return spans;
}

/**
 * Pure: turn a subject path `[{t,x,y}]` into the `reframe` DATA the compositor applies: the target aspect, the
 * planned camera track, and the motion blur on each move.
 * @returns {{aspect_w:number, aspect_h:number, track:{t:number,cx:number,cy:number}[], blur:{from:number,to:number,streak_x:number,streak_y:number}[], fill_mode?:string}}
 */
export function trackToReframe(path, { aspectW = 9, aspectH = 16, source, camera, fillMode } = {}) {
  const track = planCamera(path, { aspectW, aspectH, source, camera });
  const out = { aspect_w: aspectW, aspect_h: aspectH, track, blur: planMotionBlur(track, { aspectW, aspectH, source, camera }) };
  if (typeof fillMode === 'string' && fillMode.trim()) out.fill_mode = fillMode.trim();
  return out;
}

/** Run detect-track on a file and return its `{path,width,height,...}` (spawns the tracker CLI). */
export function trackSubject(file, { stepMs = 150, grid = 16, threshold = 128 } = {}) {
  const r = spawnSync('node', [join(HERE, 'detect-track.mjs'), file, String(stepMs), String(grid), String(threshold)], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`detect-track failed: ${r.stderr || r.status}`);
  return JSON.parse(r.stdout.trim());
}

/** Convenience: track the subject in a file and return the reframe DATA that retargets it to aspectW:aspectH. */
export function autoReframe(file, opts = {}) {
  const { path, width, height } = trackSubject(file, opts);
  return trackToReframe(path, { ...opts, source: { width, height } });
}

// CLI: node auto-reframe.mjs <file> [--aspect-w N] [--aspect-h N] [--fill blur|crop|<color>]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.error('usage: auto-reframe.mjs <file> [--aspect-w N] [--aspect-h N] [--fill blur|crop|<color>]'); process.exit(2); }
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i], v = rest[i + 1];
    if (k === '--aspect-w') opt.aspectW = Number(v);
    else if (k === '--aspect-h') opt.aspectH = Number(v);
    else if (k === '--fill') opt.fillMode = v;
  }
  process.stdout.write(JSON.stringify(autoReframe(file, opt)) + '\n');
}
