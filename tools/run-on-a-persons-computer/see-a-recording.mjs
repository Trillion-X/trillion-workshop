// computer/see-a-recording.mjs
//
// Purpose
//   Makes a recording's small pictures on the computer that captured it, at capture, so no other place has to: a still
//   (the poster), a strip of frames to scrub, a waveform (peaks, 0..1) and its length, in the same shape the browser's
//   preview maker keeps (parts/ui/show/media-preview/made-preview.tsx, MadePreview) under the file's content identity
//   as its `preview` result. A file that arrives with that result is never decoded again: the service's cover run
//   (src/namespace-preview.mjs) and every browser's preview maker read it and stop.
//
// Non-negotiable invariants
//   1. Which program sees, where it is looked for and every size is DATA: a `seeing` row of computer-sources.json
//      ({ id, check, search_path, sizes, produced_by, most_seconds }), found by the same first-row-that-answers rule as
//      hearing (keep-drive-files.mjs hearingHere). This file names no path.
//   2. Only what a picture needs is decoded: each frame is read by seeking to its moment (the program reads those parts
//      of the file), and the waveform decodes the sound alone at `sizes.peak_rate` samples a second, so a long camera
//      file is seen in seconds and in little memory.
//   3. The value is the browser maker's shape and meaning: poster at `poster_width`, the first still at a tenth of the
//      length (at most one second in), `frame_count` frames of `frame_width` side by side, peaks scaled so the loudest
//      is 1, and `video_poster_version` 1 (a still from a presented frame).
//   4. A part that cannot be made is left out, never invented; a file with no part answers null.
//   5. The still is made first and handed on alone, so the first frame is kept within about a second of capture.
//
import { execFile } from 'node:child_process';
import path from 'node:path';

const run = (program, args, { env, timeout, encoding = 'buffer' }) => new Promise((resolve, reject) => {
  execFile(program, args, { env, timeout, encoding, maxBuffer: 512 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(String(stderr).trim().split('\n').pop() || error.message));
    resolve(stdout);
  });
});

// The companion program beside the found one (the prober beside the decoder), in the same folder.
const beside = (program, name) => path.join(path.dirname(program), name);

/** What the file holds: { duration, video: { width, height } | null, audio: boolean }. */
export async function probe(row, file, exec = run) {
  const out = await exec(beside(row.program, row.probe ?? 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height:stream_side_data=rotation', '-of', 'json', file], { env: row.env, timeout: 60_000, encoding: 'utf8' });
  const facts = JSON.parse(out);
  const streams = facts.streams ?? [];
  const picture = streams.find(stream => stream.codec_type === 'video' && stream.width > 0);
  const turned = Math.abs(Number(picture?.side_data_list?.find(item => 'rotation' in item)?.rotation ?? 0)) % 180 === 90;
  const duration = Number(facts.format?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    video: picture ? (turned ? { width: picture.height, height: picture.width } : { width: picture.width, height: picture.height }) : null,
    audio: streams.some(stream => stream.codec_type === 'audio'),
  };
}

const jpegOf = bytes => `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
// The program's JPEG quality scale runs 2 (best) to 31; the browser maker's 0..1 quality maps onto it.
const qualityOf = sizes => String(Math.round(2 + (1 - Number(sizes.picture_quality ?? 0.72)) * 29));

async function stillAt(row, file, moment, width, exec) {
  const args = ['-v', 'error', ...(moment > 0 ? ['-ss', moment.toFixed(3)] : []), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', qualityOf(row.sizes), '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'];
  const bytes = await exec(row.program, args, { env: row.env, timeout: 60_000 });
  return bytes?.length ? bytes : null;
}

async function strip(row, file, facts, exec) {
  const { frame_count: count, frame_width: width } = row.sizes;
  if (!(facts.duration > 0) || !(count > 0)) return null;
  const height = Math.max(2, Math.round(width * facts.video.height / Math.max(1, facts.video.width) / 2) * 2);
  const inputs = [];
  const scaled = [];
  for (let index = 0; index < count; index++) {
    inputs.push('-ss', ((facts.duration * (index + 0.5)) / count).toFixed(3), '-i', file);
    scaled.push(`[${index}:v:0]scale=${width}:${height},setsar=1[f${index}]`);
  }
  const graph = `${scaled.join(';')};${Array.from({ length: count }, (_, index) => `[f${index}]`).join('')}hstack=inputs=${count}[strip]`;
  const bytes = await exec(row.program, ['-v', 'error', ...inputs, '-filter_complex', graph, '-map', '[strip]', '-frames:v', '1', '-q:v', qualityOf(row.sizes), '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { env: row.env, timeout: (row.most_seconds ?? 300) * 1000 });
  return bytes?.length ? { source: jpegOf(bytes), count, width, height } : null;
}

/** Peaks (0..1, the loudest is 1) of the file's sound in `peak_count` equal parts, as the browser maker counts them. */
export function peaksOf(samples, count) {
  const bucket = Math.max(1, Math.floor(samples.length / count));
  const raw = [];
  for (let start = 0; start + bucket <= samples.length && raw.length < count; start += bucket) {
    let loudest = 0;
    for (let at = start; at < start + bucket; at++) loudest = Math.max(loudest, Math.abs(samples[at]));
    raw.push(loudest);
  }
  if (!raw.length) return null;
  const top = Math.max(...raw, 0.0001);
  return raw.map(value => Math.round((value / top) * 1000) / 1000);
}

async function peaks(row, file, exec) {
  const rate = String(row.sizes.peak_rate ?? 1000);
  const bytes = await exec(row.program, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', rate, '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { env: row.env, timeout: (row.most_seconds ?? 300) * 1000 });
  if (!bytes?.length) return null;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  return peaksOf(Float32Array.from(samples, value => value / 32768), row.sizes.peak_count);
}

/**
 * The preview value for one recording, made with a seeing row from hearingHere over the `seeing` rows (its found
 * `program` and `env`): { poster, video_poster_version, frames, peaks, duration }, each part only when it could be
 * made, or null when none could. The still comes first and is handed to `onStill` at once (under a second even for a
 * camera's largest file), so it can be kept while the strip and the waveform, which read the whole length, are made
 * side by side. `exec` runs a program (tests hand their own).
 */
export async function seeWith(row, file, exec = run, onStill = async () => {}) {
  const facts = await probe(row, file, exec);
  const made = {};
  if (facts.duration > 0) made.duration = Math.round(facts.duration * 1000) / 1000;
  if (facts.video) {
    const poster = await stillAt(row, file, Math.min(1, facts.duration * 0.1), row.sizes.poster_width, exec).catch(() => null);
    if (poster) {
      Object.assign(made, { poster: jpegOf(poster), video_poster_version: 1 });
      await onStill({ ...made });
    }
  }
  const [frames, heard] = await Promise.all([
    facts.video ? strip(row, file, facts, exec).catch(() => null) : null,
    facts.audio ? peaks(row, file, exec).catch(() => null) : null,
  ]);
  if (frames) made.frames = frames;
  if (heard) made.peaks = heard;
  return made.poster || made.peaks ? made : null;
}

/** Whether a kept preview already serves: a drawable part, and for a video a presented-frame still with its length. */
export const seenAlready = (value, video) => Boolean(value && (value.poster || value.peaks?.length || value.frames?.source)
  && (!video || (value.video_poster_version === 1 && value.duration !== 0)));
