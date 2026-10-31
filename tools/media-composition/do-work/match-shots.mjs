/**
 * file: tools/media-composition/do-work/match-shots.mjs
 *
 * PURPOSE: Make every shot of an edit sit at one look. A producer like color-match.mjs: it measures, writes the result as
 * DATA (a 3D LUT per shot), and returns the same edit with each matched clip's `grade` extended by `lut3d` of its LUT, so
 * the render is the ordinary grade seam of video-compose.mjs with no new render code.
 *
 * The transfer is Reinhard et al. 2001 ("Color Transfer between Images") in CIE L*a*b*: each clip that names a
 * `shot_match.group` is measured on `samples` frames of its own in..out window (edge_s in from each end; one middle frame
 * when the window is shorter than min_span_s), THROUGH its grade at the edit's picture size, so what is measured is what
 * is rendered. The group's target is the mean over its clips of each clip's mean and spread, and each clip moves to it:
 * out = (in - mean) * clamp(target_std / std, 0.8, 1.2) + target_mean, blended with the input by strength. A clip that
 * names `shot_match.like: <segment id>` (a held frame of a shot) takes that segment's LUT.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. A clip with no `shot_match` is returned unchanged; the edit's other fields are never touched.
 * 2. The LUT files are written to the folder the caller names; the edit names them by path.
 * 3. A clip that takes the match of a segment that was not measured is refused by name.
 *
 * Usage: node match-shots.mjs --edl JSON --folder DIR [--samples 5 --edge-s 0.25 --min-span-s 0.5 --strength 1]
 * Output (stdout, JSON, last line): the edit with each matched clip's grade extended.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRenderDimensions } from './resolve-render-dimensions.mjs';

const M = [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]];
const WHITE = M.map(row => row[0] + row[1] + row[2]);
const INV = invert3(M);

function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

const toLin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = c => { const v = Math.min(1, Math.max(0, c)); return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055; };
const F_EDGE = (6 / 29) ** 3;

/** CIE L*a*b* of an sRGB colour in 0..1 */
export function lab([r, g, b]) {
  const lin = [toLin(r), toLin(g), toLin(b)];
  const f = M.map((row, k) => {
    const v = (row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]) / WHITE[k];
    return v > F_EDGE ? Math.cbrt(v) : v / (3 * (6 / 29) ** 2) + 4 / 29;
  });
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

/** sRGB in 0..1 of a CIE L*a*b* colour */
export function rgbOf([L, a, b]) {
  const fy = (L + 16) / 116;
  const f = [fy + a / 500, fy, fy - b / 200];
  const xyz = f.map((v, k) => (v > 6 / 29 ? v ** 3 : 3 * (6 / 29) ** 2 * (v - 4 / 29)) * WHITE[k]);
  return INV.map(row => toSrgb(row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2]));
}

/** {mean, std} per L*a*b* channel over rgb24 pixel bytes */
export function labStats(bytes) {
  const n = bytes.length / 3;
  const sum = [0, 0, 0], sq = [0, 0, 0];
  for (let p = 0; p < n; p += 1) {
    const v = lab([bytes[p * 3] / 255, bytes[p * 3 + 1] / 255, bytes[p * 3 + 2] / 255]);
    for (let c = 0; c < 3; c += 1) { sum[c] += v[c]; sq[c] += v[c] * v[c]; }
  }
  const mean = sum.map(s => s / n);
  return { mean, std: sq.map((s, c) => Math.sqrt(Math.max(0, s / n - mean[c] * mean[c]))) };
}

/** the 33-point .cube text that moves colours with stats `from` toward stats `to`, blended by strength */
export function cubeText(from, to, strength, title, n = 33) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${n}`];
  const ratio = [0, 1, 2].map(c => Math.min(1.2, Math.max(0.8, to.std[c] / Math.max(from.std[c], 1e-6))));
  for (let bi = 0; bi < n; bi += 1) for (let gi = 0; gi < n; gi += 1) for (let ri = 0; ri < n; ri += 1) {
    const L = lab([ri / (n - 1), gi / (n - 1), bi / (n - 1)]);
    const moved = L.map((v, c) => v + strength * ((v - from.mean[c]) * ratio[c] + to.mean[c] - v));
    lines.push(rgbOf(moved).map(v => v.toFixed(6)).join(' '));
  }
  return `${lines.join('\n')}\n`;
}

function quoted(path) {
  if (path.includes("'")) throw new Error(`The LUT folder ${path} holds a quote; name a folder without one.`);
  return /[:,;[\]=\\ ]/.test(path) ? `'${path}'` : path;
}

/**
 * The picture a clip is fitted to the edit's size by, as video-compose renders it: stretched to the size, or (a
 * `reframe` whose fill_mode is a colour) fitted inside it with bars of that colour. A follow-crop or blurred fill is
 * refused: its frame depends on a moving window this measure does not draw.
 */
function fitted(segment, size) {
  const fill = typeof segment.reframe?.fill_mode === 'string' ? segment.reframe.fill_mode.trim() : null;
  if (!segment.reframe) return [`scale=${size.width}:${size.height}`];
  if (fill && fill !== 'crop' && fill !== 'blur')
    return [`scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease`, `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=${fill}`];
  throw new Error(`Clip ${segment.id} is reframed with a crop or blur fill; a shot match measures clips that are stretched or fitted with bars.`);
}

/** the pixels of the frame at `t` of a clip's source, fitted and graded as it is rendered, 320 px wide */
function measuredFrame(segment, t, size) {
  const chain = [...fitted(segment, size), 'setsar=1', 'format=yuv420p', ...(segment.grade ? [segment.grade] : []), 'scale=320:-2', 'format=rgb24'].join(',');
  try {
    return execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', t.toFixed(3), '-i', segment.source, '-frames:v', '1', '-vf', chain, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  } catch (error) {
    throw new Error(`A shot could not be measured at ${t.toFixed(3)} s of ${segment.source}: ${String(error.stderr || error.message).slice(-300)}`);
  }
}

const sampleTimes = (a, b, rules) => (b - a > rules.min_span_s
  ? Array.from({ length: rules.samples }, (_, k) => a + rules.edge_s + (rules.samples === 1 ? 0 : (k * (b - a - 2 * rules.edge_s)) / (rules.samples - 1)))
  : [(a + b) / 2]);

/** the edit with each matched clip's grade extended by `lut3d` of its LUT (written into folder) */
export function matchShots(edl, folder, rules = {}) {
  const r = { samples: 5, edge_s: 0.25, min_span_s: 0.5, strength: 1, ...rules };
  const size = resolveRenderDimensions(edl.encode ?? {});
  const segments = edl.spine?.segments ?? [];
  const groups = new Map();
  for (const s of segments) {
    if (!s.shot_match?.group) continue;
    if (!Number.isFinite(s.in) || !Number.isFinite(s.out)) throw new Error(`Clip ${s.id} names shot_match.group but has no in and out to measure.`);
    const pixels = Buffer.concat(sampleTimes(s.in, s.out, r).map(t => measuredFrame(s, t, size)));
    if (!groups.has(s.shot_match.group)) groups.set(s.shot_match.group, new Map());
    groups.get(s.shot_match.group).set(s.id, labStats(pixels));
  }
  mkdirSync(folder, { recursive: true });
  const luts = new Map();
  for (const [group, measured] of groups) {
    const all = [...measured.values()];
    const target = { mean: [0, 1, 2].map(c => all.reduce((x, m) => x + m.mean[c], 0) / all.length), std: [0, 1, 2].map(c => all.reduce((x, m) => x + m.std[c], 0) / all.length) };
    for (const [id, stats] of measured) {
      const file = join(folder, `${id}.cube`);
      writeFileSync(file, cubeText(stats, target, r.strength, `shot match ${group} ${id}`));
      luts.set(id, file);
    }
  }
  const withLut = (s, file) => ({ ...s, grade: [s.grade, `lut3d=file=${quoted(file)}`].filter(Boolean).join(',') });
  return {
    ...edl,
    spine: {
      ...edl.spine,
      segments: segments.map(s => {
        if (!s.shot_match) return s;
        const id = s.shot_match.like ?? s.id;
        if (!luts.has(id)) throw new Error(`Clip ${s.id} takes the shot match of ${id}, which has no measured shot.`);
        const { shot_match: _done, ...rest } = s;
        return withLut(rest, luts.get(id));
      }),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at].replace(/^--/, ''), process.argv[at + 1]);
  try {
    if (!args.get('edl') || !args.get('folder')) throw new Error('usage: match-shots.mjs --edl JSON --folder DIR [--samples N --edge-s S --min-span-s S --strength X]');
    const rules = {};
    for (const [flag, key] of [['samples', 'samples'], ['edge-s', 'edge_s'], ['min-span-s', 'min_span_s'], ['strength', 'strength']]) if (args.has(flag)) rules[key] = Number(args.get(flag));
    process.stdout.write(`${JSON.stringify(matchShots(JSON.parse(args.get('edl')), args.get('folder'), rules))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
