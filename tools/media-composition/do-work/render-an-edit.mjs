/**
 * file: packages/media-composition/do-work/render-an-edit.mjs
 *
 * PURPOSE: Render one edit (an EDL, the package's `contract::edl`) to a video file and report what was made: the
 * one place every authoring script (cut-and-caption, change-speed-over-a-range, reframe-to-a-size, arranged layouts)
 * hands its edit to video-compose.mjs, so they all render the same way and report the same measured facts.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. The render is video-compose.mjs, run as its own process; this file adds no filter and no look. An edit that
 *    names no picture size renders at its first clip's own size (editWithItsOwnSize).
 * 2. What is reported is MEASURED from the written file (ffprobe), never copied from the edit.
 * 3. Failures carry video-compose's own words and exit non-zero.
 *
 * Usage: node render-an-edit.mjs --edl JSON --output FILE
 * Output (stdout, JSON, last line): { duration_seconds, width, height, has_audio, bytes, segments }
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPOSE = join(dirname(fileURLToPath(import.meta.url)), 'video-compose.mjs');

/** The measured facts of a written video file. */
export function measureVideo(file) {
  const probed = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], { encoding: 'utf8' }));
  const picture = (probed.streams ?? []).find(stream => stream.codec_type === 'video');
  return {
    duration_seconds: Math.round(Number(probed.format?.duration) * 1000) / 1000,
    width: picture?.width ?? null,
    height: picture?.height ?? null,
    has_audio: (probed.streams ?? []).some(stream => stream.codec_type === 'audio'),
    bytes: statSync(file).size,
  };
}

/**
 * The edit as it is rendered: one that names no picture size (`encode.resolution`, `width` or `height`) and opens on
 * a clip of a video keeps that clip's own size, so a portrait phone video stays portrait instead of being stretched
 * onto video-compose's landscape default. An edit that names a size, or opens on something that is not a video
 * clip, is returned unchanged.
 */
export function editWithItsOwnSize(edl) {
  const encode = edl?.encode ?? {};
  if (['resolution', 'width', 'height'].some(name => encode[name] !== undefined)) return edl;
  const first = edl?.spine?.segments?.[0];
  if (first?.kind !== 'clip' || typeof first.source !== 'string') return edl;
  return { ...edl, encode: { ...encode, resolution: 'source' } };
}

/** Render `edl` to `output` with video-compose and return the measured result. */
export function renderEdl(edl, output) {
  try {
    execFileSync(process.execPath, [COMPOSE, '--edl', JSON.stringify(editWithItsOwnSize(edl)), '--out', output], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // Node's stack trace and version line close every crash, so the words kept are the lines that say what failed.
    const said = String(error.stderr || error.message).split('\n').filter(line => line.trim() && !/^\s+at |^Node\.js v|^\s*\^+\s*$/.test(line));
    throw new Error(`The edit could not be rendered: ${said.slice(-3).join(' ').slice(0, 2000)}`);
  }
  return { ...measureVideo(output), segments: edl?.spine?.segments?.length ?? 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at].replace(/^--/, ''), process.argv[at + 1]);
  try {
    if (!args.get('edl') || !args.get('output')) throw new Error('usage: render-an-edit.mjs --edl JSON --output FILE');
    let edl;
    try { edl = JSON.parse(args.get('edl')); } catch { throw new Error('The edit is not JSON.'); }
    process.stdout.write(`${JSON.stringify(renderEdl(edl, args.get('output')))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
