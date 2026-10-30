/**
 * file: tools/media-composition/do-work/layer-over-video.mjs
 *
 * PURPOSE: Lay sounds (music, voice-over, sound effects) and pictures (picture-in-picture, a logo, b-roll) over one
 * whole video and render the result: the container job behind `tool:mix-sound-layers` and
 * `tool:layer-pictures-over-video`. The layers mean what `read-data/layers-to-edit.mjs` says they mean, the same
 * translation the web editor's Layers panel uses; the render is `render-an-edit.mjs`.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. No filter here: the layers become the edit's own fields and video-compose.mjs renders them.
 * 2. What is measured (the video's length, a picture file being a still or a moving video, a file's length) is read
 *    with ffprobe from the files themselves, never assumed.
 * 3. Unusable layers are refused with every reason at once, before anything renders.
 *
 * Usage: node layer-over-video.mjs --video FILE [--sounds JSON] [--pictures JSON] [--loudness LUFS] --output FILE
 * Output (stdout, JSON, last line): { duration_seconds, expected_duration_seconds, width, height, has_audio, bytes,
 *   sounds, pictures }
 */
import { execFileSync } from 'node:child_process';
import { layerProblems, layersToEdit } from '../read-data/layers-to-edit.mjs';
import { renderEdl } from './render-an-edit.mjs';

/** The facts a layer needs from a file: its length in seconds, its picture width, and whether it is a still. */
export function probeFile(file) {
  const probed = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,width', '-of', 'json', file], { encoding: 'utf8' }));
  const picture = (probed.streams ?? []).find(stream => stream.codec_type === 'video');
  const format = String(probed.format?.format_name ?? '');
  const duration = Number(probed.format?.duration);
  return {
    duration: Number.isFinite(duration) ? duration : null,
    width: picture?.width ?? null,
    still: Boolean(picture) && (format.includes('image2') || format.endsWith('_pipe')),
  };
}

/** Pictures with what the caller left out filled from the files: whether each is a still, and how long it shows
 *  (a still to the end of the video, a moving video its own length, both no later than the video's end). */
export function withMeasuredPictures(pictures, videoSeconds, probe = probeFile) {
  return pictures.map(layer => {
    const facts = probe(layer.file);
    const kind = layer.kind ?? (facts.still ? 'image' : 'video');
    const from = Number.isFinite(layer.from) ? layer.from : 0;
    const room = Math.max(0, videoSeconds - (Number.isFinite(layer.start) ? layer.start : 0));
    const own = kind === 'video' && Number.isFinite(facts.duration) ? facts.duration - from : room;
    return { ...layer, kind, from, to: Number.isFinite(layer.to) ? layer.to : from + Math.min(room, own) };
  });
}

/** The edit that plays the whole `video` with these layers over it. */
export function layeredEdit({ video, videoSeconds, frameWidth, sounds = [], pictures = [], loudness }) {
  const problems = layerProblems({ sounds, pictures });
  if (!sounds.length && !pictures.length) problems.push('Add at least one sound or picture to lay over the video.');
  if (problems.length) throw new Error(problems.join(' '));
  return {
    spine: { segments: [{ kind: 'clip', id: 'video', source: video, in: 0, out: videoSeconds }] },
    ...layersToEdit({ sounds, pictures, loudness }, { frameWidth }),
  };
}

function jsonArg(text, name) {
  if (text === undefined || text === '') return [];
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${name} is not JSON.`); }
  if (!Array.isArray(value)) throw new Error(`Send ${name} as a list.`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at].replace(/^--/, ''), process.argv[at + 1]);
  try {
    if (!args.get('video') || !args.get('output')) throw new Error('usage: layer-over-video.mjs --video FILE [--sounds JSON] [--pictures JSON] [--loudness LUFS] --output FILE');
    const video = probeFile(args.get('video'));
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.width) throw new Error('The video has no pictures or no length to lay anything over.');
    const loudness = args.get('loudness') === undefined || args.get('loudness') === '' ? undefined : Number(args.get('loudness'));
    if (loudness !== undefined && (!Number.isFinite(loudness) || loudness < -40 || loudness > -5)) throw new Error('Loudness is a number from -40 to -5 (LUFS); -14 suits most sites.');
    const sounds = jsonArg(args.get('sounds'), 'sounds');
    const pictures = withMeasuredPictures(jsonArg(args.get('pictures'), 'pictures'), video.duration);
    const edl = layeredEdit({ video: args.get('video'), videoSeconds: video.duration, frameWidth: video.width, sounds, pictures, loudness });
    const result = renderEdl(edl, args.get('output'));
    process.stdout.write(`${JSON.stringify({ ...result, expected_duration_seconds: Math.round(video.duration * 1000) / 1000, sounds: sounds.length, pictures: pictures.length })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
